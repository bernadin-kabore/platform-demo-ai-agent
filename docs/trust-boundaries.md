# Trust boundaries

What this agent is allowed to do, who decides, and where each decision is
enforced.

## Start here: the plain version

A developer picks their service from a dropdown and describes a problem. The
agent is then allowed to read the platform's four repositories and the two
repositories belonging to that service's application — nothing else — and it may
change only the files that belong to that one service. Its only possible output
is a pull request that a person has to approve.

The important part is the word *picks*. The developer does not type a repository
name and the agent does not infer one from the request text. The service comes
from the software catalog, the catalog says who owns it and where it lives, and
the agent checks that the person asking is on that team. If any of that is
uncertain, the request is refused rather than narrowed.

**Why "which repository" stopped being enough.** An application is now one
source repository holding several services and one GitOps repository holding all
of their deployment state. Two services in the same repository can belong to
different on-call rotations, and the files at the top of each repository —
the CI pipeline, the shared Helm chart, the per-environment defaults — are
rendered by every service at once. So a scope that resolved only to a repository
would authorize changes nobody asked for. What a request may write is therefore
a *path*: one directory in the source repository, and one file per environment
in the GitOps repository.

So the worst thing a confused or manipulated agent can do is open a bad pull
request touching one service that the requesting team already owns. That is the
entire blast radius, and it is bounded by code rather than by instructions in a
prompt.

## The boundary, drawn once

```
Developer picks a Component  ──►  Backstage resolves it from the catalog
   (EntityPicker, no free text)      source repo   ← github.com/project-slug
                                     source path   ← platform.acme.io/source-path
                                     gitops repo   ← platform.acme.io/gitops-repo
                                     gitops service← platform.acme.io/gitops-service
                                     application   ← spec.system
                                     owner         ← spec.owner
                                          │
                                          ▼
                              POST /v1/requests  { intent, requester, serviceContext }
                                          │
                                          ▼
                     ┌────────────────────────────────────────┐
                     │  src/scope.ts — validateServiceContext │  ← the boundary
                     │  · shape of every field                │
                     │  · neither repo is a platform repo     │
                     │  · the two repos are not the same one  │
                     │  · paths cannot traverse or escape     │
                     │  · requester owns the entity           │
                     │  fails closed: 403, no record created  │
                     └────────────────────────────────────────┘
                                          │
                                   RequestScope (immutable)
                                    repos AND paths
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
              classifier            specialists              eval gate
           (plans within it)     (tools enforce it)     (re-checks it)
```

`RequestScope` is constructed once, in `server.ts`, before the request is
stored and before any model has seen the text. It has no mutating method. Every
later decision reads from it.

## Who enforces what

| Decision | Enforced in | Not enforced by |
|---|---|---|
| Which service a request is about | The catalog, via the EntityPicker | The request text |
| Whether the requester may act on it | `validateServiceContext`, comparing `requester` to `spec.owner` | Backstage's say-so — the agent re-checks |
| Which repositories a specialist may read | `assertReadable`, per tool call | The system prompt |
| Which paths a specialist may write | `assertWritablePath` → `RequestScope.isWritablePath`, per proposal | The catalog — the path convention lives in `scope.ts`, not in an annotation |
| Which it may write | `assertWritable`, per tool call | The system prompt |
| That nothing out of scope slipped through | `authorization/repo-scope` and `authorization/path-scope` in the eval gate | — |
| Whether a change reaches production | Existing CI, policy, `terraform plan`, human review, ArgoCD, Kyverno | Anything in this repository |

The last two rows are the ones worth dwelling on. The eval gate re-checks
authorization even though the tool layer already refused every out-of-scope
write when it happened, because enforcement at one layer is a policy and
enforcement at two independent layers is a boundary. And nothing in this agent
decides whether a change ships — the AI layer produces candidates, and the
platform that existed before it decides.

## What the agent can and cannot do

**Can:**

- Read the four platform repositories, always.
- Read and propose changes to the two repositories of one application, when a developer who
  owns it selected it.
- Open pull requests, labelled `ai-generated` and `needs-human-approval`.
- Refuse, and say why.

**Cannot:**

- Reach any other team's service. Not by being asked, not by being persuaded,
  not by a request that names it in prose. That now includes a sibling service
  sharing the same repository: the repository grant does not carry the path.
- Change anything shared by an application's services — its CI pipeline, its
  Helm chart, its per-environment defaults, its ApplicationSet. Those reach
  teams that did not ask, so they are a platform change or a human's.
- Merge, approve, or review a pull request — including its own.
- Bypass a branch ruleset. This App has no bypass actor entry anywhere, which is
  why human approval is a real gate here rather than a formality. Neither, now,
  does `platform-deploy-bot`: it used to hold one on scaffolded repositories so
  CI could push image-tag bumps to a protected branch, and under the application
  model CI opens a pull request against the GitOps repository instead. Nothing
  on this platform pushes past a ruleset any more.
- Run a command against the cluster, read live data, or rotate a credential. It
  holds no kubeconfig. Its entire AWS permission is `bedrock-mantle:CreateInference`
  on two model ARNs.
- Widen its own scope. There is no code path that adds a repository or a path to
  a `RequestScope` after construction.

## The specialist split: expertise is not ownership

A specialist is a domain of expertise. Being the right expert for a question
does not by itself grant the right to write the answer anywhere.

| Specialist | Writes platform | Source / GitOps | Why |
|---|---|---|---|
| `terraform` | terraform-modules | **read** / **read** | Diagnosing whether a service needs AWS infrastructure means reading its deployment state; if the answer is a Helm value, that is Application's change |
| `application` | templates, backstage | **write** / **write** | Owns the service's values file, where nearly every service-scoped fix lands, and its code |
| `security` | gitops, templates | **read** | Says which control a service trips and what compliance looks like; the compliant config is written by Application |
| `observability` | gitops, templates | **write** / **write** | An alert about one service ships as `prometheusRules` in that service's own values; instrumentation is code |

Security holding read-and-not-write on application repositories is the
deliberate one. It means "make my app pass the policy" cannot be answered by
editing the app until the check stops noticing — the diagnosis and the fix are
made by different specialists with different reach.

## Untrusted input, and where it stops

The request text is untrusted. It reaches:

- the classifier, framed explicitly as "the developer wrote", after the service
  has already been stated as settled fact;
- the specialist briefs, written by the classifier;
- the pull request body, where a reviewer needs it.

It does **not** reach any authorization decision. The classifier's output is
narrowed by `reconcile()`, which drops every specialist write the scope does not
permit and can only ever remove. A plan claiming a service the scope does not
have is downgraded to platform-wide, not honoured.

## Deliberate omissions

Recorded here rather than discovered later.

- **No platform-team override.** `platform-team` asking about `checkout-api` is
  denied like anyone else. Fail closed was chosen over convenience; adding an
  admin group is a one-line change in `validateServiceContext` if that turns out
  to be wrong, and it should be an explicit decision rather than a default.
- **The GitHub App's installation must now cover application repositories.**
  This is the real privilege increase in service-scoped requests: the App's
  reach grows from four known repositories to every repository it is installed
  on. The compensating controls are the per-request scope, branch protection on
  every scaffolded repository, and no bypass actor anywhere. Install it on the
  repositories the platform scaffolds, not organisation-wide, if the choice is
  available.
- **Nothing prevents a developer pasting sensitive data into the intent field.**
  It is validated for length only. It reaches the model, the pod's logs, and the
  pull request body. The title now uses the classifier's restatement rather than
  the raw text, which narrows that a little, but this is an open gap rather than
  a solved problem.
- **The eval gate's scope re-check cannot see reads.** It validates the
  repositories that were *written*. A read refused by `assertReadable` is
  recorded as a denial and surfaced, but there is no second, independent check
  that no unauthorized read happened — only the tool layer enforces that.

## Future bounded autonomy

`src/autonomy.ts` defines the levels and compiles in the ceiling. Every run
today ends at **level 2 — generate a pull request**, and `MAX_AUTONOMY_LEVEL` is
a constant rather than configuration so that raising it is a code change that
goes through review.

```
0  read and analyse
1  recommend in writing
2  generate a pull request        ← the ceiling, enforced by withinCeiling()
───────────────────────────────── everything above needs a control that does
3  execute in non-production      not exist yet
4  execute bounded production
```

The extension point for telemetry-driven runs is `TriggerSource`. A run started
by a detector rather than a person is capped at level 1 by `autonomyFor()` —
that branch is unreachable today, which is the point of writing it now.

The blocker on level 3 is named in that file and worth repeating: the only
record of an approval is a GitHub review, and the same App credential that would
perform an action can read that review's state. Nothing stops a confused agent
from reading "a review exists" as "this specific change was approved". Whoever
builds level 3 has to solve that first.
