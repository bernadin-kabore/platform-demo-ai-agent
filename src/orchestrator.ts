import { trace } from '@opentelemetry/api';

import type { ChangeSet, PlatformRequest } from './agents/types.js';
import { AuditTrail } from './audit.js';
import { evaluate } from './evals/harness.js';
import { openPullRequests } from './github.js';
import { logger } from './logger.js';
import { classify } from './plan/classify.js';
import { executePlan } from './plan/execute.js';
import type { RequestScope } from './scope.js';
import type { RequestStore } from './store.js';

const tracer = trace.getTracer('ai-platform-agent');

export interface OrchestratorDeps {
  store: RequestStore;
  /**
   * The request's authorization scope, built at admission in server.ts and
   * immutable thereafter. Passed in rather than derived here so there is
   * exactly one place in the system where a scope comes into existence.
   */
  scope: RequestScope;
}

/**
 * Runs one platform request end to end: classify, plan, generate, evaluate,
 * and — only if the evals pass — open pull requests.
 *
 * The order is the architecture. Classification happens before any repository
 * is read, so a misunderstanding is visible before it has cost anything;
 * execution follows a plan rather than a conversation, so what ran can be
 * reconstructed; evaluation happens before GitHub, so a bad change set costs a
 * model call rather than a reviewer's afternoon.
 *
 * Everything downstream of `openPullRequests` is the platform that already
 * existed before any of this was added. The generated pull request meets the
 * same Trivy, Semgrep, Checkov, tfsec and coverage gates as a hand-written one;
 * a Terraform change gets the same `terraform plan` posted to the pull request;
 * the branch ruleset still demands an approving human review; and ArgoCD only
 * sees the change once that review merges it. The AI layer produces candidate
 * changes. It does not shorten the path those changes travel.
 */
export async function handleRequest(request: PlatformRequest, deps: OrchestratorDeps): Promise<void> {
  const audit = new AuditTrail(request.id);
  const { scope } = deps;

  await tracer.startActiveSpan('orchestrate', async (span) => {
    span.setAttribute('request.id', request.id);
    span.setAttribute('request.requester', request.requester);
    if (scope.service) {
      span.setAttribute('request.service', scope.service.entityRef);
      span.setAttribute('request.source_repo', scope.service.sourceRepo);
      span.setAttribute('request.source_path', scope.service.sourcePath);
      span.setAttribute('request.gitops_repo', scope.service.gitopsRepo);
    }

    try {
      // Records that a request arrived and what it was authorized for. The
      // intent text is not repeated here: it is already on the request record,
      // and the audit trail is rendered into a pull request body, so anything
      // written into it becomes a permanent public artifact.
      audit.record('orchestrator', 'request accepted', {
        requester: request.requester,
        entityRef: scope.service?.entityRef,
        applicationRepos: scope.applicationRepos,
      });

      deps.store.update(request.id, { status: 'classifying', audit: [...audit.entries()] });
      const plan = await classify({ request, scope, audit });
      deps.store.update(request.id, { status: 'planning', plan, audit: [...audit.entries()] });
      span.setAttribute('plan.scope', plan.ownershipScope);
      span.setAttribute('plan.risk', plan.risk);
      span.setAttribute('plan.autonomy', plan.autonomy);

      deps.store.update(request.id, { status: 'generating' });
      const { changeSets, conflicts } = await executePlan(plan, scope, audit, (partial: ChangeSet[]) => {
        deps.store.update(request.id, { changeSets: [...partial], audit: [...audit.entries()] });
      });

      audit.record('orchestrator', 'generation complete', {
        agentsInvoked: changeSets.map((set) => set.agent),
        files: changeSets.reduce((total, set) => total + set.files.length, 0),
        denials: changeSets.reduce((total, set) => total + set.denials.length, 0),
        conflicts: conflicts.length,
      });

      deps.store.update(request.id, {
        status: 'evaluating',
        changeSets,
        audit: [...audit.entries()],
      });
      const evaluation = await evaluate(request, changeSets, audit, { scope, conflicts });
      deps.store.update(request.id, { evaluation, audit: [...audit.entries()] });

      if (!evaluation.passed) {
        audit.record('orchestrator', 'rejected by evals', {
          score: Number(evaluation.judge.score.toFixed(3)),
          blockingFailures: evaluation.blockingFailures.length,
        });
        deps.store.update(request.id, { status: 'rejected', audit: [...audit.entries()] });
        span.setAttribute('outcome', 'rejected');
        return;
      }

      const pullRequests = await openPullRequests(request, plan, changeSets, evaluation, audit);
      audit.record('orchestrator', 'run complete', {
        pullRequests: pullRequests.map((pr) => pr.url),
      });
      deps.store.update(request.id, {
        status: 'pull-requests-open',
        pullRequests,
        audit: [...audit.entries()],
      });
      span.setAttribute('outcome', 'pull-requests-open');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, requestId: request.id }, 'request failed');
      audit.record('orchestrator', 'run failed', { error: message });
      deps.store.update(request.id, {
        status: 'failed',
        error: message,
        audit: [...audit.entries()],
      });
      span.recordException(error as Error);
      span.setAttribute('outcome', 'failed');
    } finally {
      span.end();
    }
  });
}
