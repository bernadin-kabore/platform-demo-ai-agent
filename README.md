# platform-demo-ai-agent

The AI Platform Agent. A developer describes what they want in the portal; this
service turns that into pull requests across the platform repositories, scores
them, and stops if they are not good enough.

It is the only new *runtime* in the AI-assisted platform. Everything that
happens to its output afterwards — policy scanning, `terraform plan`, human
approval, GitOps, EKS — is the platform that already existed.

```
Developer
   ↓
Backstage                          "AI Platform Request" template
   ↓                               → platform:ai:request scaffolder action
AI Platform Agent                  ← this repository
   │
   ├── Terraform Agent             AWS: modules, IRSA, ECR, envs/dev
   ├── Application Agent           golden path: templates, shared chart, portal
   ├── Security Agent              Kyverno, supply chain, least privilege
   └── Observability Agent         collector pipelines, alerts, SLOs, dashboards
             ↓
        Generated PRs              one per target repository, labelled ai-generated
             ↓
       Automated Evals             ← this repository (src/evals)
             ↓
      Policy / Security            existing: Trivy, Semgrep, gitleaks, CodeQL, Checkov, tfsec, Kyverno
             ↓
      Terraform Plan               existing: terraform-ci.yml plan-dev, posted to the PR
             ↓
       Human Approval              existing: branch protection, 1 approving review, signed commits
             ↓
           GitOps                  existing: ArgoCD ApplicationSets
             ↓
            EKS
```

## The one idea this is built on

**The agent's entire reach into the world is "open a pull request against a
protected branch."**

Not "apply Terraform". Not "kubectl". Not "merge". It holds no cluster
credential, no AWS write permission beyond invoking a model, and no ruleset
bypass anywhere. Its four specialists have exactly five tools between them, and
only one of those changes anything — `propose_file_change`, which appends to an
array in memory.

That constraint is what makes the rest of the architecture honest. Every gate
downstream of the agent was already protecting this platform from human
mistakes; none of them needed to be weakened to let an agent through, and none
of them were. The AI layer adds candidate changes. It does not shorten the path
those changes travel.

## Layout

```
src/
├── index.ts            process entrypoint, graceful shutdown
├── server.ts           the four HTTP routes Backstage calls
├── orchestrator.ts     routes a request to specialists, then to evals, then to GitHub
├── agents/
│   ├── index.ts        the four specialists: scope + system prompt
│   ├── subAgent.ts     the loop each specialist runs
│   └── types.ts        ChangeSet, ProposedFile, the sub-agent contract
├── tools/
│   ├── repo.ts         the five tools — four read-only, one that appends a proposal
│   └── platformContext.ts   what the platform already ships, as data
├── evals/
│   ├── checks.ts       deterministic checks; these can veto on their own
│   ├── judge.ts        rubric scoring; this can only lower a verdict
│   ├── harness.ts      the gate
│   └── run-suite.ts    the regression suite, offline and live
├── github.ts           GitHub App: reads, branch, commits, pull request
├── bedrock.ts          Claude in Amazon Bedrock via IRSA
└── audit.ts            append-only record of every action, rendered into the PR
evals/cases/            recorded change sets and the verdict the gate must return
```

## Why Bedrock rather than the Anthropic API

Because this platform has no way to deliver a secret.

External Secrets is item 1 of `PLATFORM_ROADMAP.md` Part 2 and does not exist.
An API key would therefore have to be a hand-created Kubernetes Secret — the
exact anti-pattern the roadmap says to fix. Claude in Amazon Bedrock needs no
key: the pod assumes an IAM role through the same IRSA mechanism Crossplane,
OpenCost, Karpenter and external-dns already use, and the SDK signs each request
with the credentials that role projects into it.

Concretely, `modules/irsa` is reused verbatim and the model is reached at
`https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages` with SigV4.
Model IDs there carry an `anthropic.` prefix — `anthropic.claude-opus-5`.

Two Bedrock constraints shaped the code:

- **No structured outputs.** Where a typed result is needed — the eval judge's
  verdict — it comes back as a forced tool call with a JSON schema rather than
  `output_config.format`.
- **No server-side tools.** Every tool here is client-implemented. That is a
  constraint worth having: it is what makes the agent's action surface
  enumerable, and an action surface you can enumerate is one you can gate.

Swapping to the first-party API later is a change to `src/bedrock.ts` and an
`ExternalSecret`. Nothing else in the codebase names a provider.

## The eval gate

Two layers, in this order, and the order is the point.

**Deterministic checks** (`src/evals/checks.ts`) run first and can reject on
their own. They are cheap, they cannot be talked out of a verdict, and several
encode defects this platform has actually hit rather than ones it might
hypothetically hit:

| Check | What it catches |
|---|---|
| `yaml-parses`, `json-parses` | Output that would break an ArgoCD sync |
| `kyverno/require-labels`, `require-probes`, `require-resource-limits`, `disallow-latest-tag`, `pod-security-restricted` | A manifest that admission would refuse — caught for one API call instead of a stuck Application |
| `kyverno/no-silent-downgrade` | An enforced policy moved to Audit inside a change set about something else |
| `supply-chain/ci-must-retain-controls` | A service CI workflow "edited" by rewriting a short one that drops cosign, Syft and Trivy |
| `terraform/no-comments-in-policy-json` | The `_comment` key that AWS rejected on this platform's first real apply |
| `terraform/use-irsa-module` | A hand-rolled web-identity trust policy instead of `modules/irsa` |
| `no-secrets` | A credential-shaped string in a proposed file |
| `reviewable-size`, `produced-changes` | A change set nobody can review, or one that claims work while proposing nothing |

**A review model** (`src/evals/judge.ts`) runs second, scoring five rubric
dimensions: does it answer the request, does it follow the conventions, does it
avoid rebuilding what exists, can a reviewer check it, was it honest about what
it did not know. It can only *lower* a verdict the deterministic checks already
permitted — a judge shares a failure mode with the model that wrote the change,
and a control that fails the same way as the thing it controls is not a control.

### Running the suite

```bash
npm run evals        # offline: replays recorded fixtures. Free, deterministic. Runs on every PR.
npm run evals:live   # live: real intents through the real orchestrator against Bedrock. Costs money.
```

Offline cases assert *the gate's* verdict on a recorded change set. Live cases
assert *the agent's* behaviour on an intent. These are different claims and the
suite keeps them apart, because a fixture is usually a recorded example of the
very mistake the case exists to catch — "the agent must not do this" and "the
fixture does exactly this" are both true at once.

## HTTP API

| Route | Purpose |
|---|---|
| `POST /v1/requests` | `{ intent, requester, service? }` → `202 { id }`. Processing is asynchronous; a run takes minutes. |
| `GET /v1/requests/:id` | Status, change sets, eval report, pull request links |
| `GET /v1/requests` | Recent runs |
| `GET /healthz`, `/readyz` | Probes |

## Local development

```bash
npm ci
npm run typecheck
npm test          # unit tests for the deterministic checks
npm run evals     # offline regression suite
npm run build
```

Talking to Bedrock locally needs AWS credentials with `bedrock-mantle:CreateInference`
on the model ARN and model access enabled in the Bedrock console. Opening pull
requests needs the GitHub App credentials listed in `src/config.ts`.

## Deployment

The image is built, scanned, signed and SBOM-attested by
[`ci.yml`](.github/workflows/ci.yml), which then opens a pull request against
`platform-demo-gitops` bumping the digest in `apps/ai-platform-agent/`.

Note the asymmetry with scaffolded services: those push their image-tag bump
straight to their own `main`, because `platform-deploy-bot` has a ruleset bypass
there. This component deploys out of the GitOps repository, whose `main` is
protected by Terraform with no bypass actor at all. So a new version of the
agent reaches the cluster only when a human merges it — which seems like the
right rule for the one component that can open pull requests everywhere else.

## Known risks

Recorded honestly rather than discovered later.

- **The tool-runner path on Bedrock is unproven here.** The loop uses the SDK's
  `client.beta.messages.toolRunner`. Tool use itself is supported on Bedrock;
  the beta namespace routing is the part this repository has not yet exercised
  against a live endpoint. If it turns out unavailable, the replacement is the
  manual request/execute/re-request loop — the tools and their handlers are
  plain functions and are unchanged by that swap.
- **Nothing here has run against a real cluster.** Same caveat the roadmap makes
  about the rest of the platform, and it applies at least as strongly to a
  component that has never been deployed.
- **The judge is a review model, not a safety control.** It is deliberately
  positioned so it cannot rescue a change set, only fail one.
- **The eval threshold is a guess.** `EVAL_MIN_SCORE` defaults to 0.8 with no
  score distribution behind it. The honest way to set it is to run the live
  suite enough times to see the distribution first.
