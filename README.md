# platform-demo-ai-agent

The AI Platform Agent. A developer describes what they want in the portal; this
service turns that into pull requests across the platform repositories, scores
them, and stops if they are not good enough.

---

## Start here: what this actually does

Five assistants that read the platform's own code and write draft changes for a
human to approve. They cannot deploy anything, merge anything, or touch AWS.

They are not five programs. This is **one service that holds five separate
conversations with Claude**, each given different instructions and different
access:

| | Knows about | Allowed to edit | Your service's repo |
|---|---|---|---|
| **The classifier** | which specialist handles what | nothing — it only plans | — |
| **Terraform** | AWS: networks, clusters, permissions | the Terraform repo | read only |
| **Application** | your service's configuration: Helm values, resources, probes | the templates + portal repos | **can change it** |
| **Security** | what the cluster refuses to run | the GitOps + templates repos | read only |
| **Observability** | metrics, logs, traces, alerts | the GitOps + templates repos | **can change it** |

Those last two columns are enforced in code, not by asking the model nicely. The
Security specialist *cannot* write Terraform even if it decides it would like
to — the tool call comes back as an error instead.

The right-hand column is newer and is the more interesting one. If a developer
selects their service in the portal, some specialists may propose changes in
that service's own repository — and only that one. Which service it is comes
from the software catalog, not from the request text, and the agent checks that
the requesting team owns it. See [docs/trust-boundaries.md](trust-boundaries.md)
for where each of those decisions is enforced.

### What happens when someone asks for something

Say a developer types this into Backstage:

> *"We never know when a service starts crash-looping."*

1. **The classifier reads it** and writes down a plan before anything else
   happens: what it thinks was asked, who should work on it, which repositories
   they may read, which they intend to change, and how risky that is. This is
   an alerting problem, so it wakes the Observability specialist only. The other
   three never run — a request that touches one part of the platform should not
   produce a pull request touching four.

   The plan comes back to the portal before any file is read, so if the platform
   misunderstood the request, that is visible immediately rather than after a
   diff has been built on top of it.

2. **That specialist goes and reads the repository.** Not from memory: it opens
   the actual files to see how this platform writes things, because a change
   that is technically correct but idiomatically foreign still gets rejected in
   review.

3. **It writes a complete draft file** and hands it back. Nothing is saved
   anywhere yet — a proposal is an entry in an array in memory until it clears
   the next step.

4. **The work gets checked, twice.** First by fast, dumb rules: does this YAML
   parse, would Kubernetes refuse this pod, did it just quietly delete the image
   scanning? Then by a second Claude that scores it — does this actually answer
   what was asked, or does it merely look like it does?

5. **If it passes, a pull request appears.** If it fails, nothing appears and
   the portal shows the reason, which is usually the useful part.

6. **A human reviews and merges it.** That is the moment it becomes real, and it
   is the only such moment.

### What they cannot do

Their entire power is *"open a pull request."* That is the whole list.

They cannot merge — not even in this repository. They have no kubeconfig and no
cluster access. Their AWS permission grants exactly one action: ask Claude a
question. Nothing else.

And they cannot reach another team's service. A request is authorized for the
platform repositories plus, at most, the one service the developer selected and
their team owns. Asking in the request text for something else — "while you're
in there, fix payments-api too" — does not widen it: the scope is fixed before
the text is read, and the refusal is recorded on the pull request.

So the worst outcome from a confused agent is a bad pull request that wastes
someone's time, and step 4 exists mostly to prevent even that.

### Why bother at all

The scaffolder templates already handle *"I need a new service"* perfectly, in
seconds, for nothing — and those requests are never routed through a model.

This is for the other kind of request. The one with no template, that used to
become a ticket, or a Slack thread, or nothing at all.

---

## The architecture

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

Only the top four boxes are new. This service is the only new *runtime* in the
AI-assisted platform; everything below `Generated PRs` — policy scanning,
`terraform plan`, human approval, GitOps, EKS — is the platform that already
existed, untouched.

## Why the boundary is the design

The plain version above is "they can only open a pull request." Here is why
that single constraint is load-bearing rather than a nicety.

Its four specialists have exactly five tools between them, and only one of
those changes anything: `propose_file_change`, which appends to an array in
memory. Repository scope is a check in the tool handler, not a line in a
prompt, so a specialist reaching outside its scope gets an error result and has
to route the work to whoever owns it.

That is what makes the rest of the architecture honest. Every gate downstream of
the agent was already protecting this platform from human mistakes; none of them
needed to be weakened to let an agent through, and none of them were. The AI
layer adds candidate changes. It does not shorten the path those changes travel.

It also means the failure modes are bounded and boring. A confused agent
produces a bad pull request. It cannot produce a bad deploy, because it has no
route to one.

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

This used to be an asymmetry worth pointing out: scaffolded services pushed
their image-tag bump straight to their own `main` under a `platform-deploy-bot`
ruleset bypass, while this component had to ask. It is not an asymmetry any
more. Applications now deploy from a GitOps repository of their own, and their
pipelines open a pull request against it exactly as this one does. Nothing on
the platform holds a ruleset bypass, so no image reaches the cluster without a
human merging something — which was always the right rule for the one component
that can open pull requests everywhere else, and is now the rule everywhere.

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
