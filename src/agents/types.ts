import type { ApplicationRepoAccess, ServiceContext } from '../scope.js';

/**
 * A single file the agent proposes to write. Nothing here has touched GitHub
 * yet — a change set is an inert value until the eval gate passes and
 * `openPullRequests` turns it into commits.
 *
 * `repo` is a plain string rather than the PlatformRepo union it used to be.
 * That is a deliberate loss of compile-time safety, made once, for a reason
 * worth stating: the repository a service-scoped request may write is resolved
 * from the Backstage catalog at runtime and cannot be a literal type. The check
 * that replaced it is stronger, not weaker — `assertWritable` in tools/repo.ts
 * consults the request's immutable scope on every single call, where the union
 * only ever constrained what the code could express, not what it could reach.
 */
export interface ProposedFile {
  repo: string;
  path: string;
  contents: string;
  /** Why this file changed, in the agent's own words. Lands in the PR body. */
  rationale: string;
  /**
   * The file's contents on the base branch at the moment the agent read it, or
   * null if the agent is creating a new file. Recorded so the eval gate can
   * measure how much of an existing file a whole-file proposal actually
   * changed — see the scoped-change check in evals/checks.ts.
   */
  baseContents?: string | null;
}

export interface ChangeSet {
  agent: SubAgentName;
  files: ProposedFile[];
  /** The sub-agent's own summary of what it did and what it deliberately did not do. */
  summary: string;
  /** Anything the agent could not resolve and wants the reviewer to decide. */
  openQuestions: string[];
  /**
   * Authorization refusals this specialist hit. Kept rather than discarded: a
   * denial is the most interesting thing that can happen in a run, both for the
   * reviewer reading the pull request and for whoever is asking whether the
   * boundary actually holds.
   */
  denials: string[];
}

export type SubAgentName = 'terraform' | 'application' | 'security' | 'observability';

export interface SubAgentDefinition {
  name: SubAgentName;
  /** Shown to the classifier as the routing description — this is how routing happens. */
  description: string;
  /**
   * One line naming the domain of expertise, independent of any repository.
   * Rendered into the execution plan so a reader can see *why* a specialist was
   * chosen before seeing where it was allowed to write.
   */
  domain: string;
  systemPrompt: string;
  /**
   * Platform repositories this specialist may *write*. Every specialist may
   * read all four regardless; writing is what this list rations.
   *
   * Enforced in code, not by the prompt: a tool call naming a repo outside the
   * effective grant returns an error result rather than doing the work. The
   * security agent cannot rewrite Terraform, and the Terraform agent cannot
   * relax a Kyverno policy, no matter what the model decides it would like.
   */
  platformRepos: readonly string[];
  /**
   * How far this specialist reaches into the two application repositories
   * resolved for the request, when there is a service in scope. Separating
   * these from `platformRepos` is the point of the expertise/ownership split:
   * knowing about IAM does not imply a right to edit a team's service, and
   * being able to diagnose a problem does not require being able to fix it in
   * place.
   *
   * The two are separate from each other because they are separate kinds of
   * change. Raising a memory limit is deployment state; changing what the
   * service does when it runs out of memory is code. A specialist can
   * legitimately own one and not the other, and in this platform most of them
   * do. Both are narrowed further by path — see RequestScope.isWritablePath.
   */
  sourceAccess: ApplicationRepoAccess;
  gitopsAccess: ApplicationRepoAccess;
}

export interface PlatformRequest {
  id: string;
  intent: string;
  /** The requesting group, from the portal's OwnerPicker. Never free text. */
  requester: string;
  /**
   * The catalog-resolved service this request is scoped to, if the developer
   * selected one. Resolved by Backstage from a Component the developer picked,
   * then independently re-validated here — including the ownership check —
   * before it becomes part of the authorization boundary. See src/scope.ts.
   */
  service?: ServiceContext;
  createdAt: string;
}

export type RequestStatus =
  | 'accepted'
  | 'classifying'
  | 'planning'
  | 'generating'
  | 'evaluating'
  | 'rejected'
  | 'pull-requests-open'
  | 'failed';

export interface RequestRecord {
  request: PlatformRequest;
  status: RequestStatus;
  plan?: import('../plan/types.js').ExecutionPlan;
  changeSets: ChangeSet[];
  evaluation?: import('../evals/harness.js').EvalReport;
  pullRequests: { repo: string; url: string }[];
  error?: string;
  audit: import('../audit.js').AuditEntry[];
}
