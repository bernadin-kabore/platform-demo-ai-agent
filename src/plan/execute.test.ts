import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SubAgentName } from '../agents/types.js';
import { toWaves } from './execute.js';
import type { PlannedSpecialist } from './types.js';

/**
 * Tests for how a plan is scheduled.
 *
 * `toWaves` is exported for exactly this: the rest of `executePlan` calls
 * Bedrock, so the scheduling decision is the part worth testing on its own, and
 * it is also the part where a mistake is expensive — a wrong wave either
 * deadlocks the run or lets two specialists race each other into the same file.
 */
function specialist(
  agent: SubAgentName,
  dependsOn: SubAgentName[] = [],
): PlannedSpecialist {
  return { agent, task: 't', reason: 'r', dependsOn, reposToRead: [], intendedWrites: [] };
}

const names = (waves: PlannedSpecialist[][]): SubAgentName[][] =>
  waves.map((wave) => wave.map((entry) => entry.agent));

test('independent specialists all run in the first wave', () => {
  const waves = toWaves([specialist('application'), specialist('observability')]);
  assert.equal(waves.length, 1);
  assert.deepEqual(names(waves), [['application', 'observability']]);
});

test('a declared dependency puts the dependant in a later wave', () => {
  // The real case: an IRSA role must exist before a service account can be
  // annotated with its ARN.
  const waves = toWaves([specialist('application', ['terraform']), specialist('terraform')]);
  assert.deepEqual(names(waves), [['terraform'], ['application']]);
});

test('a chain of dependencies produces one wave per link', () => {
  const waves = toWaves([
    specialist('observability', ['application']),
    specialist('application', ['terraform']),
    specialist('terraform'),
  ]);
  assert.deepEqual(names(waves), [['terraform'], ['application'], ['observability']]);
});

test('an independent specialist runs alongside the first link of a chain', () => {
  const waves = toWaves([
    specialist('application', ['terraform']),
    specialist('terraform'),
    specialist('security'),
  ]);
  assert.deepEqual(names(waves), [['terraform', 'security'], ['application']]);
});

test('a dependency cycle fails the run rather than hanging it', () => {
  // Waiting forever for a dependency that will never resolve is the worst
  // possible failure here: the pod stays healthy, the portal keeps polling, and
  // nothing ever says why.
  assert.throws(
    () =>
      toWaves([
        specialist('application', ['observability']),
        specialist('observability', ['application']),
      ]),
    /dependency cycle/,
  );
});
