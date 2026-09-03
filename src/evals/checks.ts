import { parse as parseYaml, parseAllDocuments } from 'yaml';

import type { ChangeSet, ProposedFile } from '../agents/types.js';

/**
 * Deterministic checks that run before any model is asked for an opinion.
 *
 * These are cheap, they are not fooled by a persuasive rationale, and several
 * of them encode defects this platform has actually hit rather than defects it
 * might hypothetically hit. A blocking failure here stops the run — no pull
 * request is opened — regardless of what the judge would have scored it.
 *
 * They deliberately overlap with gates that already exist downstream (Kyverno
 * at admission, Checkov and tfsec in Terraform CI, Trivy in service CI). The
 * overlap is the point: catching a policy violation here costs one API call,
 * catching it at admission costs a reviewer's afternoon and a failed sync.
 */
export interface CheckResult {
  check: string;
  file?: string;
  passed: boolean;
  blocking: boolean;
  message: string;
}

type Check = (file: ProposedFile) => CheckResult[];

const K8S_KINDS_WITH_PODS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'Rollout']);

function ok(check: string, file: string, message: string): CheckResult {
  return { check, file, passed: true, blocking: false, message };
}

function fail(check: string, file: string, message: string, blocking = true): CheckResult {
  return { check, file, passed: false, blocking, message };
}

const isYaml = (path: string) => path.endsWith('.yaml') || path.endsWith('.yml');

/** Every YAML file the agent writes must actually parse. */
const yamlParses: Check = (file) => {
  if (!isYaml(file.path)) return [];
  try {
    const documents = parseAllDocuments(file.contents);
    const errors = documents.flatMap((doc) => doc.errors);
    if (errors.length) {
      return [fail('yaml-parses', file.path, `YAML does not parse: ${errors[0]?.message ?? 'unknown error'}`)];
    }
    return [ok('yaml-parses', file.path, `${documents.length} YAML document(s) parse cleanly`)];
  } catch (error) {
    return [fail('yaml-parses', file.path, `YAML does not parse: ${(error as Error).message}`)];
  }
};

/** JSON files must parse — config.json drives the whole ApplicationSet. */
const jsonParses: Check = (file) => {
  if (!file.path.endsWith('.json')) return [];
  try {
    JSON.parse(file.contents);
    return [ok('json-parses', file.path, 'JSON parses cleanly')];
  } catch (error) {
    return [fail('json-parses', file.path, `JSON does not parse: ${(error as Error).message}`)];
  }
};

/**
 * Pre-flight the Kyverno policies that are already enforced in the cluster.
 * A manifest failing here would be admitted by ArgoCD's sync and then refused
 * by the admission webhook, which surfaces as a stuck Application rather than
 * as an obvious error.
 */
const kubernetesPolicyPreflight: Check = (file) => {
  if (!isYaml(file.path)) return [];
  let documents: unknown[];
  try {
    documents = parseAllDocuments(file.contents).map((doc) => doc.toJS());
  } catch {
    return []; // yamlParses already reported this
  }

  const results: CheckResult[] = [];
  for (const document of documents) {
    if (!document || typeof document !== 'object') continue;
    const manifest = document as Record<string, any>;
    if (!K8S_KINDS_WITH_PODS.has(manifest.kind)) continue;

    const podSpec = manifest.spec?.template?.spec;
    if (!podSpec) continue;
    const labels: Record<string, string> = manifest.spec?.template?.metadata?.labels ?? {};
    const containers: Record<string, any>[] = podSpec.containers ?? [];
    const where = `${manifest.kind}/${manifest.metadata?.name ?? '(unnamed)'}`;

    if (!labels['app.kubernetes.io/name'] || !labels.team) {
      results.push(
        fail(
          'kyverno/require-labels',
          file.path,
          `${where} pod template is missing app.kubernetes.io/name and/or team labels; require-labels rejects it at admission.`,
        ),
      );
    }

    for (const container of containers) {
      const name = container.name ?? '(unnamed container)';
      if (!container.livenessProbe || !container.readinessProbe) {
        results.push(
          fail(
            'kyverno/require-probes',
            file.path,
            `${where} container "${name}" is missing a livenessProbe and/or readinessProbe.`,
          ),
        );
      }
      const requests = container.resources?.requests;
      const limits = container.resources?.limits;
      if (!requests?.cpu || !requests?.memory || !limits?.memory) {
        results.push(
          fail(
            'kyverno/require-resource-limits',
            file.path,
            `${where} container "${name}" must set resources.requests.cpu, resources.requests.memory and resources.limits.memory.`,
          ),
        );
      }
      const image: string = container.image ?? '';
      if (image.endsWith(':latest') || (image && !image.includes(':') && !image.includes('@'))) {
        results.push(
          fail('kyverno/disallow-latest-tag', file.path, `${where} container "${name}" uses an implicit or explicit :latest tag.`),
        );
      }
      const security = container.securityContext ?? {};
      if (security.allowPrivilegeEscalation !== false || security.runAsNonRoot !== true) {
        results.push(
          fail(
            'kyverno/pod-security-restricted',
            file.path,
            `${where} container "${name}" must set securityContext.allowPrivilegeEscalation: false and runAsNonRoot: true.`,
          ),
        );
      }
    }

    if (!results.some((r) => r.file === file.path && !r.passed)) {
      results.push(ok('kyverno-preflight', file.path, `${where} satisfies the enforced admission policies`));
    }
  }
  return results;
};

/**
 * A Kyverno policy the agent proposes must itself be well-formed, and must not
 * quietly downgrade an existing Enforce policy to Audit. Weakening a control is
 * a legitimate change to make — it is not a legitimate change to make silently.
 */
const kyvernoPolicyShape: Check = (file) => {
  if (!file.path.includes('apps/kyverno/policies/') || !isYaml(file.path)) return [];
  const results: CheckResult[] = [];
  let manifest: Record<string, any>;
  try {
    manifest = parseYaml(file.contents);
  } catch {
    return [];
  }
  if (manifest?.kind !== 'ClusterPolicy' && manifest?.kind !== 'Policy') {
    return [fail('kyverno/policy-kind', file.path, 'Files under apps/kyverno/policies/ must be a Kyverno Policy or ClusterPolicy.')];
  }
  const action = manifest.spec?.validationFailureAction;
  if (action !== 'Enforce' && action !== 'Audit') {
    results.push(
      fail('kyverno/policy-action', file.path, 'spec.validationFailureAction must be explicitly Enforce or Audit.'),
    );
  } else {
    results.push(ok('kyverno/policy-action', file.path, `Policy is in ${action} mode`));
  }
  if (!manifest.metadata?.annotations?.['policies.kyverno.io/severity']) {
    results.push(
      fail(
        'kyverno/policy-annotations',
        file.path,
        'Missing the policies.kyverno.io/severity annotation that every existing policy carries.',
        false,
      ),
    );
  }
  return results;
};

/**
 * The nine Kyverno policies that are in Enforce mode in the cluster today.
 *
 * An agent may add a policy and may tighten one. It may not move one out of
 * Enforce. Downgrading an admission control is sometimes the right call, but
 * it is a decision with a blast radius that a human takes deliberately and in
 * its own pull request — not something that arrives folded into a change set
 * whose stated purpose was to make deploys faster.
 */
const ENFORCED_POLICIES = new Set([
  'disallow-latest-tag',
  'disallow-default-namespace',
  'pod-security-restricted',
  'require-labels',
  'require-probes',
  'require-resource-limits',
  'restrict-image-registries',
  'require-signed-images',
  'require-sbom-attestation',
]);

const noSilentPolicyDowngrade: Check = (file) => {
  if (!file.path.includes('apps/kyverno/policies/') || !isYaml(file.path)) return [];
  let manifest: Record<string, any>;
  try {
    manifest = parseYaml(file.contents);
  } catch {
    return [];
  }
  const name: string | undefined = manifest?.metadata?.name;
  if (!name || !ENFORCED_POLICIES.has(name)) return [];
  if (manifest.spec?.validationFailureAction === 'Enforce') {
    return [ok('kyverno/no-silent-downgrade', file.path, `${name} remains in Enforce mode`)];
  }
  return [
    fail(
      'kyverno/no-silent-downgrade',
      file.path,
      `${name} is currently enforced and this change moves it out of Enforce. The agent may add or tighten a policy; relaxing one is a human decision that belongs in its own pull request.`,
    ),
  ];
};

/**
 * Steps the scaffolded services' CI pipeline cannot lose.
 *
 * Because a proposal replaces a whole file, the cheapest way for a model to
 * "edit" a two-hundred-line workflow is to rewrite a short one that does the
 * thing it was asked about and nothing else. The result looks like a focused
 * change and is actually the removal of every supply-chain control the
 * platform depends on — and the admission policies would then refuse to run
 * anything that pipeline built.
 */
const CI_REQUIRED_CONTROLS: [string, RegExp][] = [
  ['Trivy scanning', /trivy-action/],
  ['SBOM generation', /sbom-action/],
  ['cosign signing', /cosign sign/],
  ['SBOM attestation', /cosign attest/],
];

const ciRetainsSupplyChainControls: Check = (file) => {
  const isTemplateCi = /^templates\/[^/]+\/skeleton\/\.github\/workflows\/ci\.yml$/.test(file.path);
  if (!isTemplateCi) return [];
  const missing = CI_REQUIRED_CONTROLS.filter(([, pattern]) => !pattern.test(file.contents));
  if (missing.length) {
    return [
      fail(
        'supply-chain/ci-must-retain-controls',
        file.path,
        `This rewrite of the service CI workflow drops ${missing
          .map(([name]) => name)
          .join(', ')}. Images built by it would be refused at admission by require-signed-images and require-sbom-attestation.`,
      ),
    ];
  }
  return [ok('supply-chain/ci-must-retain-controls', file.path, 'All supply-chain controls retained')];
};

/**
 * Terraform conventions, including the two defects this repository hit on its
 * first real apply.
 */
const terraformConventions: Check = (file) => {
  if (!file.path.endsWith('.tf') && !file.path.endsWith('.json')) return [];
  const results: CheckResult[] = [];

  // Defect 1, observed: AWS rejected an IAM policy document because it carried
  // a "_comment" key. JSON policy documents have nowhere to put a comment.
  if (file.path.includes('policies/') && file.path.endsWith('.json')) {
    if (/"_?comment"\s*:/i.test(file.contents)) {
      results.push(
        fail(
          'terraform/no-comments-in-policy-json',
          file.path,
          'IAM policy documents may not contain comment keys — AWS rejects the policy. Explain the policy in the calling .tf file instead.',
        ),
      );
    } else {
      results.push(ok('terraform/no-comments-in-policy-json', file.path, 'No comment keys in the policy document'));
    }
  }

  if (file.path.endsWith('.tf')) {
    // Hand-rolled IRSA trust policies are the thing modules/irsa exists to stop.
    const rollsOwnIrsa =
      /resource\s+"aws_iam_role"/.test(file.contents) &&
      /AssumeRoleWithWebIdentity/.test(file.contents) &&
      !file.path.startsWith('modules/irsa/') &&
      !file.path.startsWith('modules/compositions/');
    if (rollsOwnIrsa) {
      results.push(
        fail(
          'terraform/use-irsa-module',
          file.path,
          'This defines a web-identity IAM role by hand. Use modules/irsa, which every other controller on this platform uses.',
        ),
      );
    }

    if (/\bResource"?\s*[:=]\s*"\*"/.test(file.contents) && !/aws:RequestedRegion/.test(file.contents)) {
      results.push(
        fail(
          'terraform/scope-wildcard-resources',
          file.path,
          'A wildcard IAM resource with no aws:RequestedRegion condition. Scope it, or add the condition the Crossplane policy uses.',
          false,
        ),
      );
    }
  }
  return results;
};

/**
 * Nothing the agent writes may contain a credential. It has no legitimate
 * reason to produce one — the platform has no secrets-delivery mechanism at
 * all yet — so any match here is either a hallucinated placeholder that would
 * be committed as though real, or something much worse.
 */
const noSecrets: Check = (file) => {
  const patterns: [string, RegExp][] = [
    ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
    ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['Anthropic API key', /\bsk-ant-[A-Za-z0-9-]{20,}\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  const hits = patterns.filter(([, pattern]) => pattern.test(file.contents));
  if (hits.length) {
    return hits.map(([name]) => fail('no-secrets', file.path, `Looks like a committed ${name}.`));
  }
  return [ok('no-secrets', file.path, 'No credential-shaped strings')];
};

/** Empty or near-empty proposals are almost always a confused agent. */
const nonTrivial: Check = (file) => {
  if (file.contents.trim().length === 0) {
    return [fail('non-trivial', file.path, 'Proposed file is empty.')];
  }
  if (!file.rationale.trim()) {
    return [fail('non-trivial', file.path, 'Proposed file has no rationale for the reviewer.', false)];
  }
  return [];
};

const CHECKS: Check[] = [
  yamlParses,
  jsonParses,
  kubernetesPolicyPreflight,
  kyvernoPolicyShape,
  noSilentPolicyDowngrade,
  ciRetainsSupplyChainControls,
  terraformConventions,
  noSecrets,
  nonTrivial,
];

/** Caps that apply to the run as a whole rather than to one file. */
const MAX_FILES_PER_RUN = 25;
const MAX_BYTES_PER_FILE = 200_000;

export function runDeterministicChecks(changeSets: ChangeSet[]): CheckResult[] {
  const files = changeSets.flatMap((set) => set.files);
  const results: CheckResult[] = [];

  if (files.length === 0) {
    results.push({
      check: 'produced-changes',
      passed: false,
      blocking: true,
      message: 'No agent proposed any file change. There is nothing to review.',
    });
  }

  if (files.length > MAX_FILES_PER_RUN) {
    results.push({
      check: 'reviewable-size',
      passed: false,
      blocking: true,
      message: `${files.length} files changed. A pull request this large is not reviewable; the request needs splitting into smaller ones.`,
    });
  }

  for (const file of files) {
    if (file.contents.length > MAX_BYTES_PER_FILE) {
      results.push(fail('reviewable-size', file.path, `File is ${file.contents.length} bytes, over the ${MAX_BYTES_PER_FILE} cap.`));
      continue;
    }
    for (const check of CHECKS) {
      results.push(...check(file));
    }
  }

  return results;
}
