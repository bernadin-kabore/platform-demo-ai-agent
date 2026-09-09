import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChangeSet, ProposedFile, SubAgentName } from '../agents/types.js';
import { RequestScope, type ServiceContext } from '../scope.js';
import { runDeterministicChecks } from './checks.js';

type TestFile = Omit<ProposedFile, 'baseContents'> & { baseContents?: string | null };

/**
 * A change set as a well-behaved specialist produces one.
 *
 * `baseContents: null` is the default because it is what the agent records
 * after reading a path and finding nothing there — the normal state for a file
 * it is about to create. Leaving it undefined means "never read", which the
 * read-before-write check blocks, and the tests that want that behaviour say so
 * explicitly with `unreadChangeSet`.
 */
function changeSet(files: TestFile[], agent: SubAgentName = 'security'): ChangeSet[] {
  return [
    {
      agent,
      files: files.map((file) => ({ baseContents: null, ...file })),
      summary: 'test',
      openQuestions: [],
      denials: [],
    },
  ];
}

/** A change set whose files were proposed without ever being read. */
function unreadChangeSet(files: TestFile[], agent: SubAgentName = 'security'): ChangeSet[] {
  return [{ agent, files: files as ProposedFile[], summary: 'test', openQuestions: [], denials: [] }];
}

const CHECKOUT_AUTH: ServiceContext = {
  entityRef: 'component:default/checkout-platform-auth',
  name: 'checkout-platform-auth',
  application: 'checkout-platform',
  owner: 'group:default/checkout-team',
  sourceRepo: 'checkout-platform-source',
  sourcePath: 'services/auth',
  gitopsRepo: 'checkout-platform-gitops',
  gitopsService: 'auth',
};

/** Where this service's deployment state lives, and the only file in the
 *  GitOps repository a request scoped to it may write. */
const AUTH_VALUES = 'environments/dev/services/auth.yaml';

const serviceScope = () => RequestScope.forService(CHECKOUT_AUTH, 'checkout-team');
const platformScope = () => RequestScope.platformOnly('platform-team');

const compliantDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: example
        team: platform-team
    spec:
      containers:
        - name: example
          image: 382334305409.dkr.ecr.us-east-1.amazonaws.com/example:abc123
          livenessProbe: { httpGet: { path: /healthz, port: 8080 } }
          readinessProbe: { httpGet: { path: /readyz, port: 8080 } }
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
`;

test('a compliant Deployment passes the admission pre-flight', () => {
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: compliantDeployment, rationale: 'r' }]),
  );
  assert.equal(
    results.filter((r) => !r.passed && r.blocking).length,
    0,
    JSON.stringify(results.filter((r) => !r.passed), null, 2),
  );
});

test('a Deployment missing probes is blocked before it reaches admission', () => {
  const withoutProbes = compliantDeployment
    .replace(/\s+livenessProbe: .*\n/, '\n')
    .replace(/\s+readinessProbe: .*\n/, '\n');
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: withoutProbes, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/require-probes' && !r.passed && r.blocking));
});

test('a :latest tag is blocked', () => {
  const latest = compliantDeployment.replace('example:abc123', 'example:latest');
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: latest, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/disallow-latest-tag' && !r.passed));
});

test('unparseable YAML is blocked', () => {
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/broken.yaml', contents: 'a:\n  - b\n c: [', rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'yaml-parses' && !r.passed && r.blocking));
});

test('a comment key inside an IAM policy document is blocked — this defect reached a real apply', () => {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    _comment: 'why this policy exists — em dash and all',
    Statement: [{ Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::example'] }],
  });
  const results = runDeterministicChecks(
    changeSet([
      { repo: 'platform-demo-terraform-modules', path: 'envs/dev/policies/example.json', contents: policy, rationale: 'r' },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'terraform/no-comments-in-policy-json' && !r.passed && r.blocking));
});

test('a hand-rolled IRSA trust policy is blocked in favour of modules/irsa', () => {
  const tf = `
resource "aws_iam_role" "thing" {
  name = "thing"
  assume_role_policy = jsonencode({
    Statement = [{ Action = "sts:AssumeRoleWithWebIdentity", Effect = "Allow" }]
  })
}
`;
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-terraform-modules', path: 'envs/dev/main.tf', contents: tf, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'terraform/use-irsa-module' && !r.passed && r.blocking));
});

test('a Kyverno policy without an explicit failure action is blocked', () => {
  const policy = `
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: example
  annotations:
    policies.kyverno.io/severity: medium
spec:
  rules: []
`;
  const results = runDeterministicChecks(
    changeSet([
      { repo: 'platform-demo-gitops', path: 'apps/kyverno/policies/example.yaml', contents: policy, rationale: 'r' },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/policy-action' && !r.passed));
});

test('a credential in a proposed file is blocked', () => {
  const results = runDeterministicChecks(
    changeSet([
      {
        repo: 'platform-demo-gitops',
        path: 'apps/x/secret.yaml',
        contents: 'key: AKIAIOSFODNN7EXAMPLE\n',
        rationale: 'r',
      },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'no-secrets' && !r.passed && r.blocking));
});

test('an empty run is blocked — there is nothing to review', () => {
  const results = runDeterministicChecks([]);
  assert.ok(results.some((r) => r.check === 'produced-changes' && !r.passed && r.blocking));
});

test('an unreviewably large run is blocked', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    repo: 'platform-demo-gitops' as const,
    path: `apps/x/file-${i}.yaml`,
    contents: 'a: 1\n',
    rationale: 'r',
  }));
  const results = runDeterministicChecks(changeSet(files));
  assert.ok(results.some((r) => r.check === 'reviewable-size' && !r.passed && r.blocking));
});


// ---------------------------------------------------------------------------
// Authorization. These are the tests that matter most: they assert the
// boundary holds at the gate, independently of the tool layer that is supposed
// to have held it already.
// ---------------------------------------------------------------------------

test('a proposal in another team’s repository is blocked as an authorization failure', () => {
  const results = runDeterministicChecks(
    changeSet(
      [{ repo: 'payments-api', path: 'chart/values.yaml', contents: 'replicaCount: 3\n', rationale: 'r' }],
      'application',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.ok(
    results.some((r) => r.check === 'authorization/repo-scope' && !r.passed && r.blocking),
    'a file in a repository outside the request scope must block the run',
  );
});

test('a proposal in the request’s own deployment state is authorized', () => {
  const results = runDeterministicChecks(
    changeSet(
      [
        {
          repo: 'checkout-platform-gitops',
          path: AUTH_VALUES,
          contents: 'replicaCount: 3\n',
          rationale: 'r',
          baseContents: 'replicaCount: 2\n',
        },
      ],
      'application',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.equal(
    results.filter((r) => r.check === 'authorization/repo-scope' && !r.passed).length,
    0,
    JSON.stringify(results.filter((r) => !r.passed), null, 2),
  );
});

test('a specialist with read-only access to the application repository may not write it', () => {
  // The security specialist can read a service's deployment state to diagnose
  // a policy violation and cannot fix it in place — that fix belongs to the
  // application domain. Without this the test would pass for the wrong
  // reason: an unknown repository is refused too, but by a different rule.
  const results = runDeterministicChecks(
    changeSet(
      [{ repo: 'checkout-platform-gitops', path: AUTH_VALUES, contents: 'replicaCount: 3\n', rationale: 'r' }],
      'security',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.ok(results.some((r) => r.check === 'authorization/repo-scope' && !r.passed && r.blocking));
});

test('a platform-only request authorizes no application repository at all', () => {
  const results = runDeterministicChecks(
    changeSet(
      [{ repo: 'checkout-platform-gitops', path: AUTH_VALUES, contents: 'replicaCount: 3\n', rationale: 'r' }],
      'application',
    ),
    { scope: platformScope(), conflicts: [] },
  );
  assert.ok(results.some((r) => r.check === 'authorization/repo-scope' && !r.passed && r.blocking));
});

test('two specialists proposing the same file blocks the run', () => {
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/a.yaml', contents: 'a: 1\n', rationale: 'r' }]),
    {
      scope: platformScope(),
      conflicts: ['platform-demo-gitops/apps/x/a.yaml was proposed by more than one specialist'],
    },
  );
  assert.ok(results.some((r) => r.check === 'plan/conflicting-proposals' && !r.passed && r.blocking));
});

// ---------------------------------------------------------------------------
// Scoped changes.
// ---------------------------------------------------------------------------

test('proposing a whole file without reading it first is blocked', () => {
  const results = runDeterministicChecks(
    unreadChangeSet([
      { repo: 'platform-demo-gitops', path: 'apps/x/a.yaml', contents: 'a: 1\n', rationale: 'r' },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'scoped-change/read-before-write' && !r.passed && r.blocking));
});

test('rewriting almost all of a substantial file is blocked', () => {
  const base = Array.from({ length: 60 }, (_, i) => `line-${i}: value`).join('\n');
  const rewritten = Array.from({ length: 60 }, (_, i) => `different-${i}: value`).join('\n');
  const results = runDeterministicChecks(
    changeSet([
      {
        repo: 'platform-demo-gitops',
        path: 'apps/x/values.yaml',
        contents: rewritten,
        rationale: 'r',
        baseContents: base,
      },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'scoped-change/minimal-diff' && !r.passed && r.blocking));
});

test('changing one line of a substantial file is not flagged', () => {
  const base = Array.from({ length: 60 }, (_, i) => `line-${i}: value`).join('\n');
  const edited = base.replace('line-7: value', 'line-7: changed');
  const results = runDeterministicChecks(
    changeSet([
      {
        repo: 'platform-demo-gitops',
        path: 'apps/x/values.yaml',
        contents: edited,
        rationale: 'r',
        baseContents: base,
      },
    ]),
  );
  assert.equal(results.filter((r) => r.check === 'scoped-change/minimal-diff' && !r.passed).length, 0);
});

test('a proposal in a sibling service’s directory is blocked as an authorization failure', () => {
  // The case the path rule exists for. Both services live in one repository, so
  // the repository grant alone would have allowed this — and the team that owns
  // payments is not the team that asked.
  const results = runDeterministicChecks(
    changeSet(
      [
        {
          repo: 'checkout-platform-source',
          path: 'services/payments/src/index.js',
          contents: 'const x = 1;\n',
          rationale: 'r',
          baseContents: 'const x = 0;\n',
        },
      ],
      'application',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.ok(results.some((r) => r.check === 'authorization/path-scope' && !r.passed && r.blocking));
});

test('a proposal in the application’s shared deployment state is blocked', () => {
  // env-values.yaml is rendered by every service in the application. Narrow as
  // the edit looks, it is not a change to the one service in scope.
  const results = runDeterministicChecks(
    changeSet(
      [
        {
          repo: 'checkout-platform-gitops',
          path: 'environments/dev/env-values.yaml',
          contents: 'replicaCount: 4\n',
          rationale: 'r',
          baseContents: 'replicaCount: 2\n',
        },
      ],
      'application',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.ok(results.some((r) => r.check === 'authorization/path-scope' && !r.passed && r.blocking));
  assert.ok(
    results.some((r) => r.check === 'application/shared-deployment-state' && !r.passed),
    'and it is reported as shared state, not only as a path violation',
  );
});

test('a service may still ship its own alerting rules', () => {
  // The capability that consolidating the chart could have removed. A rule that
  // concerns one service is values in that service's own deployment state, and
  // nothing about it is shared — so it passes cleanly.
  const results = runDeterministicChecks(
    changeSet(
      [
        {
          repo: 'checkout-platform-gitops',
          path: AUTH_VALUES,
          contents: 'replicaCount: 2\nprometheusRules:\n  - alert: OOMKilled\n    expr: up == 0\n',
          rationale: 'r',
          baseContents: 'replicaCount: 2\n',
        },
      ],
      'observability',
    ),
    { scope: serviceScope(), conflicts: [] },
  );
  assert.equal(
    results.filter((r) => !r.passed && r.blocking).length,
    0,
    'a service-scoped alert rule must not be blocked',
  );
});
