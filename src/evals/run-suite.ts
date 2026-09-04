/**
 * The agent's own regression suite — the thing that makes "Automated Evals" a
 * gate rather than a diagram box.
 *
 * Two modes, because they answer different questions and cost different
 * amounts:
 *
 *   offline (default, runs on every pull request)
 *     Replays recorded change sets through the deterministic checks and
 *     asserts the expected verdict. It costs nothing, never flakes, and
 *     catches the regression that actually happens: someone loosens a check,
 *     or changes a prompt in a way that would have let a known-bad change
 *     through. Every case that has ever failed in production gets recorded
 *     here as a fixture, so it can only fail once.
 *
 *   live (--live, run deliberately)
 *     Puts the real intent through the real orchestrator against Bedrock and
 *     asserts which specialists were routed to and what they produced. It
 *     answers "does the agent still behave sensibly", costs real money per
 *     run, and is not deterministic — so it gates a release rather than a
 *     commit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChangeSet, PlatformRequest, SubAgentName } from '../agents/types.js';
import { AuditTrail } from '../audit.js';
import { RequestScope, type ServiceContext } from '../scope.js';
import { runDeterministicChecks } from './checks.js';
import { evaluate } from './harness.js';
import { handleRequest } from '../orchestrator.js';
import { RequestStore } from '../store.js';

/**
 * What the live agent must do when given this intent. Asserted only in live
 * mode, because it is a statement about the agent's behaviour.
 */
interface LiveExpectation {
  /** Which specialists the orchestrator should route to. */
  agents?: SubAgentName[];
  /** Paths the agent must not propose changing. */
  mustNotTouch?: string[];
  /** Repositories no proposed file may belong to. The authorization assertion. */
  mustNotWriteRepos?: string[];
  /** Repositories at least one proposed file must belong to. */
  mustWriteRepos?: string[];
  /** Whether the resulting change set should clear the eval gate. */
  mustReject?: boolean;
  minScore?: number;
}

/**
 * A recorded change set plus the verdict the gate must return on it. Asserted
 * in offline mode, because it is a statement about the gate.
 *
 * The two are not the same claim, and conflating them is how an eval suite
 * ends up asserting nothing useful: a fixture is very often a recorded example
 * of the mistake the case exists to catch, so "the agent must not do this" and
 * "the fixture does exactly this" are both true at once.
 */
interface FixtureExpectation {
  /** What this recorded change set represents, for whoever reads a failure. */
  note: string;
  changeSets: ChangeSet[];
  /** Deterministic-check names that must report a blocking failure. */
  expectBlocked?: string[];
  /** Check names that must report a failure the gate flags but does not block on. */
  expectFlagged?: string[];
  /** Whether the gate must reject this recorded change set outright. */
  expectRejected: boolean;
}

/**
 * The catalog entity a case runs as, when it is service-scoped.
 *
 * Written into the case file rather than resolved from a live Backstage,
 * because the suite has to run in CI with no portal and no cluster. The shape
 * is the same one `validateServiceContext` accepts, so a case that would be
 * refused at admission is refused here too, for the same reason.
 */
type CaseService = ServiceContext;

interface EvalCase {
  name: string;
  description: string;
  intent: string;
  requester: string;
  /** Present when the case is service-scoped; absent for platform requests. */
  service?: CaseService;
  expect: LiveExpectation;
  fixture?: FixtureExpectation;
}

/** The scope a case runs under. Platform-only unless the case names a service. */
function scopeFor(testCase: EvalCase): RequestScope {
  return testCase.service
    ? RequestScope.forService(testCase.service, testCase.requester)
    : RequestScope.platformOnly(testCase.requester);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const CASE_DIR = path.resolve(here, '../../evals/cases');

function loadCases(): EvalCase[] {
  return readdirSync(CASE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(CASE_DIR, file), 'utf8')) as EvalCase);
}

interface CaseOutcome {
  name: string;
  passed: boolean;
  failures: string[];
}

function runOffline(testCase: EvalCase): CaseOutcome | null {
  const { fixture } = testCase;
  if (!fixture) return null;

  const failures: string[] = [];
  // The scope is supplied here exactly as it would be at admission, so the
  // authorization checks are exercised offline — which is the only way a
  // boundary gets regression coverage that costs nothing to run.
  const results = runDeterministicChecks(fixture.changeSets, {
    scope: scopeFor(testCase),
    conflicts: [],
  });
  const blocking = results.filter((result) => !result.passed && result.blocking).map((result) => result.check);
  const flagged = results.filter((result) => !result.passed).map((result) => result.check);

  for (const check of fixture.expectBlocked ?? []) {
    if (!blocking.includes(check)) {
      failures.push(
        `expected "${check}" to block this fixture, but the blocking checks were: ${blocking.join(', ') || '(none)'}`,
      );
    }
  }

  for (const check of fixture.expectFlagged ?? []) {
    if (!flagged.includes(check)) {
      failures.push(
        `expected "${check}" to flag this fixture, but the failing checks were: ${flagged.join(', ') || '(none)'}`,
      );
    }
  }

  const rejected = blocking.length > 0;
  if (fixture.expectRejected && !rejected) {
    failures.push(`fixture should have been rejected (${fixture.note}) but no deterministic check blocked it`);
  }
  if (!fixture.expectRejected && rejected) {
    failures.push(`fixture should have passed the deterministic checks but was blocked by: ${blocking.join(', ')}`);
  }

  return { name: testCase.name, passed: failures.length === 0, failures };
}

async function runLive(testCase: EvalCase): Promise<CaseOutcome> {
  const failures: string[] = [];
  const { expect } = testCase;

  const store = new RequestStore();
  const scope = scopeFor(testCase);
  const request: PlatformRequest = {
    id: `eval-${testCase.name}`.slice(0, 40),
    intent: testCase.intent,
    requester: testCase.requester,
    ...(testCase.service ? { service: testCase.service } : {}),
    createdAt: new Date().toISOString(),
  };
  store.create(request);
  await handleRequest(request, { store, scope });
  const record = store.get(request.id)!;

  // Live runs stop at the eval gate: a suite that opened pull requests every
  // time it ran would be worse than no suite at all.
  const evaluation =
    record.evaluation ??
    (await evaluate(request, record.changeSets, new AuditTrail(request.id), { scope, conflicts: [] }));

  if (expect.agents) {
    const actual = record.changeSets.map((set) => set.agent).sort();
    const wanted = [...expect.agents].sort();
    if (actual.join(',') !== wanted.join(',')) {
      failures.push(`expected specialists [${wanted.join(', ')}], got [${actual.join(', ') || 'none'}]`);
    }
  }

  const touched = record.changeSets.flatMap((set) => set.files.map((file) => file.path));
  for (const forbidden of expect.mustNotTouch ?? []) {
    if (touched.includes(forbidden)) {
      failures.push(`agent proposed changing ${forbidden}, which this case forbids`);
    }
  }

  // The authorization assertions. A case that expects a denial is not satisfied
  // by the agent merely declining to do the thing — it has to have been unable
  // to, and a file in a forbidden repository is proof it was able to.
  const writtenRepos = new Set(record.changeSets.flatMap((set) => set.files.map((file) => file.repo)));
  for (const forbidden of expect.mustNotWriteRepos ?? []) {
    if (writtenRepos.has(forbidden)) {
      failures.push(
        `agent proposed a file in ${forbidden}, which this request was not authorized to write. This is an authorization failure, not a quality one.`,
      );
    }
  }
  for (const required of expect.mustWriteRepos ?? []) {
    if (!writtenRepos.has(required)) {
      failures.push(
        `expected a proposed file in ${required}, but the repositories written were: ${[...writtenRepos].join(', ') || '(none)'}`,
      );
    }
  }

  if (expect.mustReject === true && evaluation.passed) {
    failures.push('expected the eval gate to reject this run, but it passed');
  }
  if (expect.mustReject === false && !evaluation.passed) {
    failures.push(`expected the eval gate to pass this run, but it was rejected: ${evaluation.judge.reasoning}`);
  }

  if (expect.minScore !== undefined && evaluation.judge.score < expect.minScore) {
    failures.push(
      `score ${evaluation.judge.score.toFixed(2)} is below the case minimum ${expect.minScore.toFixed(2)}`,
    );
  }

  return { name: testCase.name, passed: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const cases = loadCases();
  const outcomes: CaseOutcome[] = [];

  for (const testCase of cases) {
    const outcome = live ? await runLive(testCase) : runOffline(testCase);
    if (!outcome) {
      console.log(`~ ${testCase.name} (no offline fixture; live mode only)`);
      continue;
    }
    outcomes.push(outcome);
    console.log(`${outcome.passed ? '✓' : '✗'} ${outcome.name}`);
    for (const failure of outcome.failures) console.log(`    ${failure}`);
  }

  const failed = outcomes.filter((outcome) => !outcome.passed);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} cases passed (${live ? 'live' : 'offline'})`);
  if (failed.length) process.exitCode = 1;
}

await main();
