import { PLATFORM_CAPABILITIES, PLATFORM_GAPS } from './platformContext.js';

/**
 * What a *service* can ask the platform for, as opposed to what the platform is
 * made of.
 *
 * `platformContext.ts` answers "does the platform already have policy
 * enforcement" — the question a platform engineer asks. This file answers "how
 * does an application get object storage" — the question a developer asks, and
 * the one that started being asked the moment requests became service-scoped.
 *
 * The distinction is not academic. Given "my app needs somewhere to store
 * uploaded files", a model that knows only the platform inventory learns that
 * Crossplane exists and will happily write a Terraform `aws_s3_bucket`, or a raw
 * Crossplane Composition, or both. Neither is how this platform provisions a
 * bucket: a developer sets one flag in their own chart values and the existing
 * XRD does the rest. That gap between "a capability exists" and "here is the
 * sanctioned way to consume it" is exactly where an agent invents
 * infrastructure, so the consumption path is written down as data rather than
 * left to inference.
 *
 * Every entry is populated from what is actually in these repositories. An
 * entry describing a capability the platform does not have would be worse than
 * no entry at all, because the agent would confidently route a developer
 * towards it — which is why `secrets` below says, at length, that it does not
 * exist.
 */
export interface DeveloperCapability {
  capability: string;
  description: string;
  /** The sanctioned way a service asks for it. Concrete, not conceptual. */
  requestVia: string;
  /** Where the mechanism is implemented, so the agent can go and read it. */
  implementation: string;
  /** The mistake an agent makes when it does not know the entry above. */
  doNot: string;
}

export const DEVELOPER_CAPABILITIES: readonly DeveloperCapability[] = [
  {
    capability: 'object-storage',
    description:
      'An S3 bucket for a service, provisioned from the Kubernetes API and owned by the service that asked for it.',
    requestVia:
      "Set provisionS3Bucket: true in the service's environments/<environment>/services/<service>.yaml in its application's GitOps repository. The shared chart renders templates/s3-claim.yaml, which creates an XS3Bucket claim; Crossplane reconciles it into a real bucket. The New Application template exposes the same flag as a checkbox at scaffold time.",
    implementation:
      'platform-demo-gitops/apps/crossplane/compositions/ (XS3Bucket XRD + AWS Composition), rendered by platform-demo-hello-world-template/templates/application/gitops-skeleton/chart/templates/s3-claim.yaml',
    doNot:
      'Do not write an aws_s3_bucket Terraform resource, and do not write a raw Crossplane Composition, for an application that needs a bucket. Both bypass the abstraction the platform already ships, and neither is how any existing service gets storage.',
  },
  {
    capability: 'compute-resources',
    description: 'CPU and memory for a service, and how many replicas of it run.',
    requestVia:
      "resources.requests.cpu, resources.requests.memory and resources.limits.memory in the service's environments/<environment>/services/<service>.yaml, with replicaCount alongside them. Kyverno's require-resource-limits refuses a pod that omits any of the three.",
    implementation:
      'platform-demo-hello-world-template/templates/application/gitops-skeleton/chart/values.yaml and the rollout template that consumes it',
    doNot:
      'Do not raise a limit past what namespacePolicy.quota in the same values file permits — the pod is then admitted by Kyverno and refused by the ResourceQuota, which surfaces as a scheduling mystery rather than a configuration error. Read the quota block before changing the resources block.',
  },
  {
    capability: 'workload-autoscaling',
    description: 'Scaling the number of pods with load.',
    requestVia:
      'autoscaling.enabled, minReplicas, maxReplicas and targetCPUUtilizationPercentage in the service or environment values, rendered as a HorizontalPodAutoscaler.',
    implementation: 'platform-demo-hello-world-template/templates/application/gitops-skeleton/chart/templates/hpa.yaml',
    doNot:
      'Do not propose KEDA: it is a known gap, not an available capability, so event-driven scaling has to be raised as an open question. Karpenter scales nodes rather than pods and is not something a service asks for.',
  },
  {
    capability: 'progressive-delivery',
    description: 'Shipping a new version gradually and aborting automatically if error rates regress.',
    requestVia:
      'rollout.canary.steps in the service or environment values. The default is 20 → 50 → 100 with an istio-success-rate AnalysisTemplate that aborts the rollout on an error-rate regression.',
    implementation:
      'platform-demo-gitops/apps/argo-rollouts/ and platform-demo-hello-world-template/templates/application/gitops-skeleton/chart/templates/rollout.yaml',
    doNot:
      'Do not replace the Rollout with a Deployment to make a deploy simpler, and do not remove the analysis step to make one faster. Both remove the control that catches a bad release.',
  },
  {
    capability: 'telemetry',
    description: 'Metrics, traces and logs from a service, and the dashboards over them.',
    requestVia:
      'The OpenTelemetry contract only: otel.endpoint, otel.protocol and otel.serviceNamespace in the environment values, pointing at the collector gateway. Logs are written to stdout and collected by the agent DaemonSet — the application does not export them.',
    implementation: 'platform-demo-gitops/apps/observability/',
    doNot:
      'Never have a service name Prometheus, Tempo, Elasticsearch or Kafka directly: exactly one place in the platform knows which backends exist, and it is the collector gateway. Do not move log export into the application either — records buffered inside a process are lost when it crashes, and crash logs are the ones that matter.',
  },
  {
    capability: 'alerting',
    description: 'Being told when something is wrong, rather than finding out from a user.',
    requestVia:
      "A PrometheusRule. Prometheus discovers rules in every namespace (ruleSelectorNilUsesHelmValues: false), so a new rule needs no configuration change to be picked up. A rule about one service is prometheusRules in that service's environments/<environment>/services/<service>.yaml, which the application chart renders; a rule every service should have belongs in platform-demo-gitops, keyed by label.",
    implementation:
      'platform-demo-gitops/apps/observability/ — Alertmanager is deployed and there is not a single PrometheusRule yet, so this is a real gap with the mechanism already in place.',
    doNot:
      'Do not write an alert with no documented response. Every rule gets a summary annotation saying what is wrong and a description saying what the on-call person should do about it.',
  },
  {
    capability: 'ingress-and-mesh',
    description: 'Reaching a service from outside the cluster, and service-to-service traffic inside it.',
    requestVia:
      'istio.gatewayHost in the service values renders the VirtualService and DestinationRule. Mutual TLS is already on for everything: PeerAuthentication is STRICT mesh-wide and needs nothing from the service.',
    implementation:
      "platform-demo-gitops/apps/istio/ and the shared chart's virtualservice.yaml / destinationrule.yaml",
    doNot: "Do not add an Ingress resource or a second ingress controller. Istio's gateway is the one way in.",
  },
  {
    capability: 'supply-chain-security',
    description: 'Scanning, signing and attesting what a service builds.',
    requestVia:
      'Nothing. Every scaffolded service already gets Trivy (filesystem and image), Syft SBOM generation, keyless cosign signing, cosign attestation, CodeQL, Semgrep and gitleaks from the CI workflow its template ships.',
    implementation:
      'platform-demo-hello-world-template/.github/workflows/service-build.yml, called by each application\'s own ci.yml and enforced at admission by require-signed-images and require-sbom-attestation',
    doNot:
      "Do not propose adding any of these — they are there. And do not rewrite a service's ci.yml into a shorter one that does the asked-about thing: dropping the signing or SBOM steps means the images it builds are refused at admission, which surfaces as a broken deploy rather than as a broken pipeline.",
  },
  {
    capability: 'secrets',
    description: 'Delivering a credential into a running service.',
    requestVia:
      'THIS DOES NOT EXIST. There is no External Secrets Operator, no Vault, and no Secrets Manager integration. The one component that needs a credential today uses a hand-created Kubernetes Secret, documented as a known gap.',
    implementation: 'nowhere — item 1 of PLATFORM_ROADMAP.md Part 2',
    doNot:
      'Do not invent a delivery mechanism, do not propose a literal Secret manifest with a placeholder value, and do not suggest an environment variable holding the credential. Raise it as an open question and say the work is blocked on secrets management.',
  },
];

/**
 * The briefing the platform_context tool returns: both registries plus the
 * gaps, in one payload.
 *
 * Formatted JSON rather than prose because it is also an eval fixture — a
 * change here is a change the suite notices, which is the property that keeps
 * this file honest as the platform grows.
 */
export function capabilityBriefing(): string {
  return JSON.stringify(
    {
      whatAServiceCanAskFor: DEVELOPER_CAPABILITIES,
      whatThePlatformIsMadeOf: PLATFORM_CAPABILITIES,
      knownGaps: PLATFORM_GAPS,
    },
    null,
    2,
  );
}
