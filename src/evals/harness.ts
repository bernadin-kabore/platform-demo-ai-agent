import { trace } from '@opentelemetry/api';

import type { AuditTrail } from '../audit.js';
import type { ChangeSet, PlatformRequest } from '../agents/types.js';
import { config } from '../config.js';
import { type CheckResult, type EvalContext, runDeterministicChecks } from './checks.js';
import { type JudgeResult, judgeChangeSet } from './judge.js';

const tracer = trace.getTracer('ai-platform-agent');

/**
 * The "Automated Evals" stage. It sits between the agents and GitHub, and it
 * is the only thing standing between a model's output and a pull request that
 * a human then has to spend attention on.
 *
 * Ordering is deliberate. Deterministic checks run first and can veto on their
 * own; the judge runs second and can only lower the outcome. A judge cannot
 * rescue a change set that fails a blocking check, because the judge shares a
 * failure mode with the model that wrote the change and a control that fails
 * the same way as the thing it controls is not a control.
 */
export class EvalReport {
  constructor(
    readonly checks: CheckResult[],
    readonly judge: JudgeResult,
    readonly passed: boolean,
    readonly threshold: number,
  ) {}

  get blockingFailures(): CheckResult[] {
    return this.checks.filter((check) => !check.passed && check.blocking);
  }

  get advisoryFailures(): CheckResult[] {
    return this.checks.filter((check) => !check.passed && !check.blocking);
  }

  toMarkdown(): string {
    const verdict = this.passed
      ? `**Passed** — score ${this.judge.score.toFixed(2)} against a ${this.threshold.toFixed(2)} threshold.`
      : `**Failed** — score ${this.judge.score.toFixed(2)} against a ${this.threshold.toFixed(2)} threshold.`;

    const dimensions = [
      '| Dimension | Score |',
      '|---|---|',
      `| Answers the request | ${this.judge.answersTheRequest.toFixed(2)} |`,
      `| Follows platform conventions | ${this.judge.followsConventions.toFixed(2)} |`,
      `| Avoids rebuilding what exists | ${this.judge.avoidsRebuilding.toFixed(2)} |`,
      `| Reviewability | ${this.judge.reviewability.toFixed(2)} |`,
      `| Honesty about gaps | ${this.judge.honestyAboutGaps.toFixed(2)} |`,
    ].join('\n');

    const failures = [...this.blockingFailures, ...this.advisoryFailures];

    return [
      verdict,
      '',
      dimensions,
      '',
      `> ${this.judge.reasoning}`,
      '',
      ...(this.judge.blockingConcerns.length
        ? ['**Judge raised blocking concerns:**', '', ...this.judge.blockingConcerns.map((c) => `- ${c}`), '']
        : []),
      failures.length
        ? [
            '<details><summary>Deterministic checks that did not pass</summary>',
            '',
            '| Check | File | Blocking | Message |',
            '|---|---|---|---|',
            ...failures.map(
              (f) => `| \`${f.check}\` | \`${f.file ?? '—'}\` | ${f.blocking ? 'yes' : 'no'} | ${f.message} |`,
            ),
            '',
            '</details>',
          ].join('\n')
        : `All ${this.checks.length} deterministic checks passed.`,
    ].join('\n');
  }
}

export async function evaluate(
  request: PlatformRequest,
  changeSets: ChangeSet[],
  audit: AuditTrail,
  context: EvalContext,
): Promise<EvalReport> {
  return tracer.startActiveSpan('evals', async (span) => {
    try {
      const checks = runDeterministicChecks(changeSets, context);
      const blocking = checks.filter((check) => !check.passed && check.blocking);
      audit.record('evals', 'ran deterministic checks', {
        total: checks.length,
        blockingFailures: blocking.length,
      });

      if (blocking.length && config.evals.failOnAnyBlockingCheck) {
        // Do not spend a judge call on a change set that is already rejected.
        const report = new EvalReport(
          checks,
          {
            answersTheRequest: 0,
            followsConventions: 0,
            avoidsRebuilding: 0,
            reviewability: 0,
            honestyAboutGaps: 0,
            blockingConcerns: blocking.map((check) => `${check.check}: ${check.message}`),
            reasoning:
              'Deterministic checks failed, so the change set was rejected before the review model was asked for an opinion.',
            score: 0,
          },
          false,
          config.evals.minScore,
        );
        span.setAttribute('eval.passed', false);
        span.setAttribute('eval.reason', 'blocking-check');
        return report;
      }

      const judge = await judgeChangeSet(request, changeSets);
      audit.record('evals', 'ran review model', {
        score: Number(judge.score.toFixed(3)),
        blockingConcerns: judge.blockingConcerns.length,
      });

      const passed =
        judge.score >= config.evals.minScore && judge.blockingConcerns.length === 0 && blocking.length === 0;

      span.setAttribute('eval.passed', passed);
      span.setAttribute('eval.score', judge.score);
      return new EvalReport(checks, judge, passed, config.evals.minScore);
    } finally {
      span.end();
    }
  });
}
