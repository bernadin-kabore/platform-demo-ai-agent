/**
 * How much this agent is permitted to do on its own.
 *
 * Nothing in this file changes what the agent does today: every run ends at
 * level 2, and the ceiling below is a constant rather than configuration
 * precisely so that no environment variable, no prompt and no model output can
 * raise it. It exists because the platform's next phase — telemetry detecting a
 * problem and the agent diagnosing it unprompted — is a change in *what starts
 * a run*, not in what a run may do, and that distinction is much easier to hold
 * onto if the levels are written down before anything needs them.
 *
 * The progression, with the boundary that matters marked:
 *
 *   0  read and analyse            no output beyond an explanation
 *   1  recommend                   a written recommendation, no artifact
 *   2  generate a pull request     ← the ceiling, today and in this task
 *   ------------------------------ everything above needs a control that does
 *                                  not exist yet: an out-of-band approval
 *                                  record the agent cannot forge
 *   3  execute in non-production   apply an approved change to dev
 *   4  execute bounded production  pre-approved, reversible, verified actions
 *
 * Level 3 is not merely unimplemented — it is unsafe to implement while the
 * only record of an approval is a GitHub review, because the same App
 * credential that would perform the action can read that review's state and
 * nothing prevents a confused agent from mistaking "a review exists" for "this
 * specific change was approved". Whoever builds level 3 needs to solve that
 * first; this comment is here so they know it is the actual problem.
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export const AUTONOMY_LEVELS: Record<AutonomyLevel, string> = {
  0: 'read and analyse only',
  1: 'recommend a change in writing',
  2: 'generate a pull request for human review',
  3: 'execute an approved change in non-production',
  4: 'execute pre-approved, bounded, reversible production actions',
};

/**
 * The highest level this build will ever operate at. A constant, not config:
 * raising it must be a code change that goes through review, because every
 * control above it is a control that does not exist yet.
 */
export const MAX_AUTONOMY_LEVEL: AutonomyLevel = 2;

/** What kicked off a run. Today there is one; the type is the extension point. */
export type TriggerSource = 'developer-request' | 'telemetry-detection';

export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * The autonomy a run is granted, given how risky its classifier judged it and
 * what started it.
 *
 * Deliberately conservative and deliberately boring: everything lands on 2 or
 * below, and the risk level currently changes nothing about execution. It
 * changes what the pull request says, which is the honest amount of weight to
 * put on a model's self-assessment of risk. When a risk/policy engine is built
 * for level 3, this is the function it replaces, and the shape it has to keep.
 */
export function autonomyFor(
  _risk: RiskLevel,
  trigger: TriggerSource = 'developer-request',
): AutonomyLevel {
  // A telemetry-triggered run has no human waiting on it and nobody who chose
  // its words, so it may recommend but not produce an artifact until that path
  // has a review of its own. Unreachable today; the branch is the point.
  if (trigger === 'telemetry-detection') return 1;

  // Risk deliberately does not change autonomy for a developer-triggered run.
  // Every one of them ends at a pull request whether the classifier called it
  // trivial or alarming, because a pull request is already the safest artifact
  // this agent can produce and there is nothing safer to fall back to. Risk
  // changes what the pull request *says* — it is rendered into the plan in the
  // body — and it is the input a real risk engine will branch on when there is
  // a level 3 to withhold.
  return 2;
}

/** Clamp any level to the compiled ceiling. Called on every path that acts. */
export function withinCeiling(level: AutonomyLevel): AutonomyLevel {
  return level > MAX_AUTONOMY_LEVEL ? MAX_AUTONOMY_LEVEL : level;
}
