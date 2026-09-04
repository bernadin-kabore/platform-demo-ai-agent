// Every environment-specific value arrives as an environment variable set by
// the Deployment in platform-demo-gitops/apps/ai-platform-agent. Nothing about
// the environment is baked into the image — the same digest runs in dev and in
// any later environment, which is what lets Kyverno's signed-image policy
// verify one artifact rather than one per stage.

/** Repositories the agent is allowed to read from and propose changes to. */
export const PLATFORM_REPOS = {
  terraform: 'platform-demo-terraform-modules',
  gitops: 'platform-demo-gitops',
  backstage: 'platform-demo-backstage',
  templates: 'platform-demo-hello-world-template',
} as const;

export type PlatformRepo = (typeof PLATFORM_REPOS)[keyof typeof PLATFORM_REPOS];

const PLATFORM_REPO_SET: ReadonlySet<string> = new Set(Object.values(PLATFORM_REPOS));

/**
 * The trusted platform boundary, as a runtime predicate.
 *
 * It stayed a compile-time union for as long as those four were the only
 * repositories the agent could name. Service-scoped requests introduced a fifth
 * category — one application repository, resolved per request from the
 * Backstage catalog — which cannot be a literal type because it is not known
 * until a developer selects a service. So the union survives as the description
 * of the platform's own repositories, and this predicate is how the rest of the
 * code asks "is this one of ours" at runtime. See src/scope.ts.
 */
export function isPlatformRepo(repo: string): repo is PlatformRepo {
  return PLATFORM_REPO_SET.has(repo);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. It is supplied by the Deployment in platform-demo-gitops/apps/ai-platform-agent/deployment.yaml.`,
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

export const config = {
  port: optionalInt('PORT', 8080),

  // Claude in Amazon Bedrock. The pod reaches Bedrock with the credentials
  // IRSA projects into it (AssumeRoleWithWebIdentity → the role Terraform
  // creates in envs/dev/main.tf), so there is no API key anywhere in the
  // platform — which matters because External Secrets does not exist yet.
  bedrock: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    /**
     * Model IDs on the Bedrock Messages endpoint carry an `anthropic.` prefix.
     * The orchestrator and sub-agents share one model so they share one prompt
     * cache namespace; the eval judge is deliberately allowed to differ so a
     * judge regression cannot be masked by the model that produced the change.
     */
    model: process.env.AGENT_MODEL ?? 'anthropic.claude-opus-5',
    judgeModel: process.env.EVAL_JUDGE_MODEL ?? 'anthropic.claude-opus-5',
  },

  github: {
    owner: process.env.GITHUB_OWNER ?? 'bernadin-kabore',
    /** GitHub App used to open pull requests. Never a personal access token. */
    appId: optionalInt('PLATFORM_AI_AGENT_APP_ID', 0),
    installationId: optionalInt('PLATFORM_AI_AGENT_INSTALLATION_ID', 0),
    get privateKey(): string {
      return required('PLATFORM_AI_AGENT_PRIVATE_KEY');
    },
    /** Branch every generated pull request targets. */
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? 'main',
  },

  evals: {
    /**
     * A change set scoring below this is never turned into a pull request. The
     * threshold is config, not a constant, because the honest way to raise it
     * is to watch the score distribution of real runs first.
     */
    minScore: Number.parseFloat(process.env.EVAL_MIN_SCORE ?? '0.8'),
    /** Deterministic checks that must pass regardless of the judge's score. */
    failOnAnyBlockingCheck: process.env.EVAL_FAIL_ON_BLOCKING !== 'false',
  },

  /** Upper bound on sub-agent turns, so a confused agent costs a bounded amount. */
  maxAgentIterations: optionalInt('AGENT_MAX_ITERATIONS', 24),

  environment: process.env.PLATFORM_ENVIRONMENT ?? 'dev',
} as const;
