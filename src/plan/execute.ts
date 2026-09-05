import { SUB_AGENTS } from '../agents/index.js';
import { runSubAgent } from '../agents/subAgent.js';
import type { ChangeSet, SubAgentName } from '../agents/types.js';
import type { AuditTrail } from '../audit.js';
import type { RequestScope } from '../scope.js';
import type { ExecutionPlan, PlannedSpecialist } from './types.js';

/**
 * Runs a plan: specialists in dependency order, concurrently where the plan
 * says they are independent.
 *
 * The old design let the routing model call specialists one at a time as tool
 * calls, which made execution order an emergent property of a conversation.
 * Here it is derived from the plan's declared dependencies, which means it can
 * be reasoned about before the run and reconstructed after it.
 *
 * Two properties this has to guarantee, both of which the old shape got for
 * free by being sequential and lost the moment anything ran at once:
 *
 *   - A cycle must not hang the run. It is detected and the run fails, rather
 *     than waiting forever for a dependency that will never resolve.
 *   - Two specialists must not both write the same file. `propose_file_change`
 *     de-duplicates within one specialist, but each holds its own proposal
 *     array, so without a check here two change sets could each contain a
 *     different version of the same path — and `openPullRequests` would commit
 *     them in sequence, silently keeping whichever went last. That is the worst
 *     kind of bug: no error, a plausible diff, and one specialist's work gone.
 */
export interface ExecutionResult {
  changeSets: ChangeSet[];
  /**
   * Paths more than one specialist proposed. Surfaced to the eval gate as a
   * blocking failure rather than resolved here — an automatic resolution would
   * be a guess about which specialist was right, and there is no basis for one.
   */
  conflicts: string[];
}

export async function executePlan(
  plan: ExecutionPlan,
  scope: RequestScope,
  audit: AuditTrail,
  onProgress?: (changeSets: ChangeSet[]) => void,
): Promise<ExecutionResult> {
  const waves = toWaves(plan.specialists);
  const changeSets: ChangeSet[] = [];

  audit.record('orchestrator', 'execution plan scheduled', {
    waves: waves.map((wave) => wave.map((specialist) => specialist.agent)),
  });

  for (const [index, wave] of waves.entries()) {
    audit.record('orchestrator', 'starting execution wave', {
      wave: index + 1,
      agents: wave.map((specialist) => specialist.agent),
    });

    // Concurrent within a wave: everything here was declared independent, and
    // the specialists share no mutable state — each gets its own proposal
    // array, its own grant map and its own conversation. They share the audit
    // trail, whose only mutation is an append.
    const results = await Promise.all(
      wave.map((specialist) =>
        runSubAgent(SUB_AGENTS[specialist.agent], briefFor(specialist, plan, changeSets), audit, scope),
      ),
    );

    changeSets.push(...results);
    onProgress?.(changeSets);
  }

  return { changeSets, conflicts: findConflicts(changeSets, audit) };
}

/**
 * The brief a specialist actually receives: the classifier's task, plus what
 * the specialists it declared a dependency on came back with.
 *
 * A specialist sees nothing else — not the developer's words, not the plan, not
 * its peers' files. Passing a dependency's *summary* rather than its diff is
 * deliberate: what the next specialist needs is "an IRSA role called X now
 * exists", not four hundred lines of HCL, and handing over the diff invites it
 * to re-derive work that is already done.
 */
function briefFor(specialist: PlannedSpecialist, plan: ExecutionPlan, completed: ChangeSet[]): string {
  const dependencies = completed.filter((set) => specialist.dependsOn.includes(set.agent));

  return [
    specialist.task,
    '',
    '---',
    `Ownership scope for this request: ${plan.ownershipScope}.`,
    plan.targetService
      ? `It concerns ${plan.targetService}. Call what_can_i_change to see exactly which repositories that gives you.`
      : 'No single service is in scope; this is platform-wide work.',
    ...(dependencies.length
      ? [
          '',
          'Specialists that ran before you, and what they did:',
          ...dependencies.flatMap((set) => [
            '',
            `${set.agent}: ${set.summary}`,
            ...(set.files.length
              ? [`Files it proposed: ${set.files.map((file) => `${file.repo}/${file.path}`).join(', ')}`]
              : ['It proposed no files.']),
          ]),
        ]
      : []),
  ].join('\n');
}

/**
 * Group specialists into waves by dependency depth, failing closed on a cycle.
 *
 * `reconcile` in classify.ts already drops dependencies on specialists absent
 * from the plan, so the only unsatisfiable graph that can reach here is a
 * genuine cycle between two present specialists.
 */
export function toWaves(specialists: PlannedSpecialist[]): PlannedSpecialist[][] {
  const remaining = [...specialists];
  const done = new Set<SubAgentName>();
  const waves: PlannedSpecialist[][] = [];

  while (remaining.length) {
    const ready = remaining.filter((specialist) =>
      specialist.dependsOn.every((dependency) => done.has(dependency)),
    );
    if (!ready.length) {
      throw new Error(
        `The execution plan has a dependency cycle between ${remaining
          .map((specialist) => specialist.agent)
          .join(', ')}. Nothing ran.`,
      );
    }
    waves.push(ready);
    for (const specialist of ready) {
      done.add(specialist.agent);
      remaining.splice(remaining.indexOf(specialist), 1);
    }
  }

  return waves;
}

/** Paths proposed by more than one specialist, phrased for the reviewer. */
function findConflicts(changeSets: ChangeSet[], audit: AuditTrail): string[] {
  const claims = new Map<string, SubAgentName[]>();
  for (const set of changeSets) {
    for (const file of set.files) {
      const key = `${file.repo}/${file.path}`;
      const holders = claims.get(key) ?? [];
      if (!holders.includes(set.agent)) holders.push(set.agent);
      claims.set(key, holders);
    }
  }

  const conflicts: string[] = [];
  for (const [path, holders] of claims) {
    if (holders.length > 1) {
      const message = `${path} was proposed by more than one specialist (${holders.join(
        ', ',
      )}). Each supplied a complete file, so committing both would silently keep only the last one. The plan should have given this file to a single specialist.`;
      conflicts.push(message);
      audit.record('orchestrator', 'detected conflicting proposals', { path, agents: holders });
    }
  }

  return conflicts;
}
