import type { AutonomyLevel, RiskLevel, TriggerSource } from '../autonomy.js';
import type { SubAgentName } from '../agents/types.js';
import type { OwnershipScope } from '../scope.js';

/**
 * The execution plan: what the agent understood, who it intends to ask, and
 * where it believes it is allowed to write — produced before a single
 * repository is read.
 *
 * Making this a first-class artifact rather than an implicit consequence of the
 * router's tool calls is the difference between "four specialists ran and here
 * are some files" and "here is the reasoning, and here is where it was allowed
 * to lead". A reviewer can disagree with the plan without reading the diff, and
 * a denied run still produces one, which is the case where it matters most:
 * when nothing was written, the plan is the entire explanation of why.
 */
export interface PlannedSpecialist {
  agent: SubAgentName;
  /**
   * The complete brief. A specialist sees this and nothing else — not the
   * developer's words, not what the other specialists produced — so whatever
   * context it needs has to be written into here.
   */
  task: string;
  /** Why this specialist, in terms of its domain rather than its repositories. */
  reason: string;
  /**
   * Specialists whose output this one needs. An empty list means it can start
   * immediately; the executor runs everything with satisfied dependencies at
   * once and waits only where a dependency genuinely exists.
   */
  dependsOn: SubAgentName[];
  /** Repositories this specialist expects to read. Advisory: the scope decides. */
  reposToRead: string[];
  /** Repositories it expects to change, and why. Checked against the scope before it runs. */
  intendedWrites: { repo: string; reason: string }[];
}

export interface ExecutionPlan {
  /** The request restated in the platform's own vocabulary. */
  interpretedRequest: string;
  /** The catalog entity this concerns, if any. Comes from the scope, never from the model. */
  targetService?: string;
  ownershipScope: OwnershipScope;
  risk: RiskLevel;
  riskReason: string;
  trigger: TriggerSource;
  autonomy: AutonomyLevel;
  specialists: PlannedSpecialist[];
  /**
   * What the agent decided it would not do — work that belongs to another team,
   * needs a capability the platform lacks, or is too large for one change.
   * Surfacing this is what stops a partial answer from reading as a complete
   * one.
   */
  outOfScope: string[];
}

/** Rendered into the pull request body and returned to the portal. */
export function planToMarkdown(plan: ExecutionPlan): string {
  const rows = plan.specialists.map((specialist) => {
    const writes = specialist.intendedWrites.map((write) => `\`${write.repo}\``).join(', ') || '—';
    const depends = specialist.dependsOn.length ? specialist.dependsOn.join(', ') : 'none';
    return `| \`${specialist.agent}\` | ${specialist.reason} | ${writes} | ${depends} |`;
  });

  return [
    `**Interpreted as:** ${plan.interpretedRequest}`,
    '',
    `**Scope:** ${plan.ownershipScope}${plan.targetService ? ` — ${plan.targetService}` : ''}  `,
    `**Risk:** ${plan.risk} — ${plan.riskReason}  `,
    `**Autonomy:** level ${plan.autonomy} — the agent may open a pull request and nothing else.`,
    '',
    '| Specialist | Why it was chosen | Proposed writes | Waits for |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(plan.outOfScope.length
      ? ['**Deliberately not covered:**', '', ...plan.outOfScope.map((item) => `- ${item}`), '']
      : []),
  ].join('\n');
}
