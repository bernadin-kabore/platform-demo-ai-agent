/**
 * The platform's existing capabilities, as the agent sees them.
 *
 * This is the machine-readable half of PLATFORM_ROADMAP.md Part 1 ("Already
 * built. Do not rebuild."). That document exists because external advice about
 * this platform kept recommending components it already has; an LLM asked to
 * "add supply-chain security" will make exactly the same mistake for exactly
 * the same reason — it cannot see the repository — unless it is told.
 *
 * Keeping it as data rather than prose in a system prompt matters: it is one
 * of the eval suite's fixtures, so a change here is a change the evals notice.
 */
export interface Capability {
  capability: string;
  livesIn: string;
  detail: string;
}

export const PLATFORM_CAPABILITIES: readonly Capability[] = [
  {
    capability: 'Policy-as-code',
    livesIn: 'platform-demo-gitops/apps/kyverno/policies/',
    detail:
      'Nine ClusterPolicies already enforced: disallow-latest-tag, disallow-default-namespace, pod-security-restricted, require-labels, require-probes, require-resource-limits, restrict-image-registries, require-signed-images, require-sbom-attestation.',
  },
  {
    capability: 'Supply-chain security in CI',
    livesIn: 'platform-demo-hello-world-template/templates/*/skeleton/.github/workflows/ci.yml',
    detail:
      'Trivy filesystem scan, Trivy image scan, Syft SBOM via anchore/sbom-action, keyless cosign sign, cosign attest, CodeQL, Semgrep, gitleaks, and a language-appropriate SCA step. Do not propose adding any of these.',
  },
  {
    capability: 'Signature verification at admission',
    livesIn: 'platform-demo-gitops/apps/kyverno/policies/require-signed-images.yaml',
    detail:
      'Keyless cosign verification against Fulcio and Rekor, matching the CI subject https://github.com/bernadin-kabore/*/.github/workflows/ci.yml@refs/heads/main. A new image-producing repository must therefore sign from a workflow at that exact path on main.',
  },
  {
    capability: 'Progressive delivery',
    livesIn: 'platform-demo-gitops/apps/argo-rollouts/ and the shared chart rollout.yaml',
    detail:
      'Argo Rollouts canary 20 → 50 → 100 with an AnalysisTemplate (istio-success-rate) that aborts on error-rate regression.',
  },
  {
    capability: 'Service mesh',
    livesIn: 'platform-demo-gitops/apps/istio/',
    detail: 'PeerAuthentication STRICT (mTLS), ingress gateway, VirtualService/DestinationRule canary splitting.',
  },
  {
    capability: 'Infrastructure from the Kubernetes API',
    livesIn: 'platform-demo-gitops/apps/crossplane/compositions/',
    detail:
      'XS3Bucket XRD plus an AWS Composition, surfaced as a checkbox in the Backstage templates. Extending Crossplane to a new resource type reuses this XRD + Composition + Backstage-checkbox pattern rather than inventing one.',
  },
  {
    capability: 'Node autoscaling',
    livesIn: 'platform-demo-terraform-modules/modules/karpenter/ and platform-demo-gitops/apps/karpenter/',
    detail: 'IAM, SQS interruption queue, EventBridge rules, NodePool, EC2NodeClass. Karpenter scales nodes, not pods.',
  },
  {
    capability: 'Cost visibility',
    livesIn: 'platform-demo-gitops/apps/opencost/',
    detail: 'OpenCost with its own IRSA role, attributing cost by the "team" label every pod carries.',
  },
  {
    capability: 'Metrics, traces, logs, dashboards',
    livesIn: 'platform-demo-gitops/apps/observability/',
    detail:
      'kube-prometheus-stack, Grafana, Tempo, OpenTelemetry Collector (agent DaemonSet + gateway Deployment), EFK, Kiali. Applications depend on the OTLP contract only and never name a backend.',
  },
  {
    capability: 'IRSA',
    livesIn: 'platform-demo-terraform-modules/modules/irsa/',
    detail:
      'A generic module taking role_name, oidc_provider_arn, oidc_provider_url, namespace, service_account_name and either inline_policy_json or policy_arns. Any new controller needing AWS access reuses this module — never a hand-written aws_iam_role.',
  },
  {
    capability: 'Branch protection on scaffolded repositories',
    livesIn: 'platform-demo-backstage/packages/backend/src/modules/branch-protection/',
    detail:
      'A custom scaffolder action creates a GitHub ruleset on main/develop/release/* requiring a pull request, an approving review, signed commits, and the test/sast/sca/coverage checks. On a GitHub Organization this is replaced by one github_organization_ruleset resource.',
  },
];

/** Known gaps, so the agent proposes the right thing when asked for one. */
export const PLATFORM_GAPS: readonly Capability[] = [
  {
    capability: 'Secrets management',
    livesIn: 'nowhere yet',
    detail:
      'No External Secrets Operator, Vault, or AWS Secrets Manager integration exists. Anything needing a secret delivered into the cluster must say so as an open question rather than inventing a delivery mechanism.',
  },
  {
    capability: 'Alerting rules and SLOs',
    livesIn: 'nowhere yet',
    detail:
      'Alertmanager is deployed but there is not a single PrometheusRule in the repository. Prometheus discovers rules in all namespaces (ruleSelectorNilUsesHelmValues: false), so a new PrometheusRule needs no configuration change to be picked up.',
  },
  {
    capability: 'Workload autoscaling on events',
    livesIn: 'nowhere yet',
    detail: 'No KEDA. HorizontalPodAutoscaler on CPU is what the shared chart offers today.',
  },
];
