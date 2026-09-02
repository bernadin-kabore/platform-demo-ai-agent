import type { PlatformRepo } from '../config.js';

/**
 * A single file the agent proposes to write. Nothing here has touched GitHub
 * yet — a change set is an inert value until the eval gate passes and
 * `openPullRequests` turns it into commits.
 */
export interface ProposedFile {
  repo: PlatformRepo;
  path: string;
  contents: string;
  /** Why this file changed, in the agent's own words. Lands in the PR body. */
  rationale: string;
}

export interface ChangeSet {
  agent: SubAgentName;
  files: ProposedFile[];
  /** The sub-agent's own summary of what it did and what it deliberately did not do. */
  summary: string;
  /** Anything the agent could not resolve and wants the reviewer to decide. */
  openQuestions: string[];
}

export type SubAgentName = 'terraform' | 'application' | 'security' | 'observability';

export interface SubAgentDefinition {
  name: SubAgentName;
  /** Shown to the orchestrator as the tool description — this is how routing happens. */
  description: string;
  systemPrompt: string;
  /**
   * Repositories this sub-agent may read and propose changes to. Enforced in
   * code, not by the prompt: a tool call naming a repo outside this list
   * returns an error result rather than doing the work. The security agent
   * cannot rewrite Terraform, and the Terraform agent cannot relax a Kyverno
   * policy, no matter what the model decides it would like to do.
   */
  allowedRepos: readonly PlatformRepo[];
}

export interface PlatformRequest {
  id: string;
  intent: string;
  requester: string;
  /** Optional existing service the request concerns. */
  service?: string;
  createdAt: string;
}

export type RequestStatus =
  | 'accepted'
  | 'planning'
  | 'generating'
  | 'evaluating'
  | 'rejected'
  | 'pull-requests-open'
  | 'failed';

export interface RequestRecord {
  request: PlatformRequest;
  status: RequestStatus;
  changeSets: ChangeSet[];
  evaluation?: import('../evals/harness.js').EvalReport;
  pullRequests: { repo: string; url: string }[];
  error?: string;
  audit: import('../audit.js').AuditEntry[];
}
