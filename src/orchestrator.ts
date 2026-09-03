import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { SUB_AGENTS } from './agents/index.js';
import { runSubAgent } from './agents/subAgent.js';
import type { ChangeSet, PlatformRequest, SubAgentName } from './agents/types.js';
import { AuditTrail } from './audit.js';
import { bedrockClient } from './bedrock.js';
import { config } from './config.js';
import { evaluate } from './evals/harness.js';
import { openPullRequests } from './github.js';
import { logger } from './logger.js';
import { PLATFORM_CAPABILITIES, PLATFORM_GAPS } from './tools/platformContext.js';
import type { RequestStore } from './store.js';

const tracer = trace.getTracer('ai-platform-agent');

const ORCHESTRATOR_SYSTEM = `
You are the AI Platform Agent for an Internal Developer Platform. A developer
has described something they want, in their own words, through the developer
portal. Your job is to decide which specialists should work on it, brief each
one properly, and then report back.

You do not write files yourself. You have exactly four specialists:

  terraform_agent      AWS infrastructure. Anything that provisions or changes an AWS resource.
  application_agent    The golden path: scaffolder templates, the shared Helm chart, the portal.
  security_agent       Admission policy, supply chain, least privilege.
  observability_agent  Telemetry: collector pipelines, alerting rules, SLOs, dashboards.

How to do this well:

- Call only the specialists the request actually needs. A request for an alert
  needs the observability agent and nobody else. Calling all four on every
  request produces a pull request nobody wants to review.

- Brief them properly. The task you pass is the entire context that specialist
  gets — it does not see the developer's original words unless you include
  them, and it does not see what the other specialists did. Say what you want,
  why, and what you already know about the constraints.

- Order matters when work depends on other work. An IRSA role must exist before
  a service account can be annotated with it, so brief the Terraform agent
  first and pass its result to whoever needs it.

- One coherent change per request. If the developer has asked for something
  that genuinely spans a quarter of engineering effort, do the first useful
  slice and say clearly in your summary what you left out and why.

- Refuse work that is not yours. You change infrastructure-as-code through pull
  requests. You do not have, and must not claim to have, the ability to run
  commands against the cluster, read production data, rotate credentials, or
  merge anything. If the request needs one of those, say so plainly and do the
  part you can.

Your final message is what the developer sees in the portal and what the
reviewer reads at the top of the pull request. Write it for a person: what is
being proposed, what it does not cover, and what happens next.
`.trim();

export interface OrchestratorDeps {
  store: RequestStore;
}

/**
 * Runs one platform request end to end: plan, generate, evaluate, and — only
 * if the evals pass — open pull requests.
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
  const changeSets: ChangeSet[] = [];

  await tracer.startActiveSpan('orchestrate', async (span) => {
    span.setAttribute('request.id', request.id);
    span.setAttribute('request.requester', request.requester);
    try {
      deps.store.update(request.id, { status: 'planning', audit: [...audit.entries()] });
      audit.record('orchestrator', 'request accepted', { intent: request.intent, requester: request.requester });

      const tools = (Object.keys(SUB_AGENTS) as SubAgentName[]).map((name) => {
        const definition = SUB_AGENTS[name];
        return betaZodTool({
          name: `${name}_agent`,
          description: definition.description,
          inputSchema: z.object({
            task: z
              .string()
              .describe(
                'The complete brief for this specialist. It sees nothing else — not the developer\'s words, not what the other specialists did — so include everything it needs.',
              ),
          }),
          run: async ({ task }) => {
            deps.store.update(request.id, { status: 'generating' });
            const changeSet = await runSubAgent(definition, task, audit);
            changeSets.push(changeSet);
            deps.store.update(request.id, { changeSets: [...changeSets], audit: [...audit.entries()] });
            return JSON.stringify(
              {
                summary: changeSet.summary,
                filesProposed: changeSet.files.map((file) => `${file.repo}/${file.path}`),
                openQuestions: changeSet.openQuestions,
              },
              null,
              2,
            );
          },
        });
      });

      const runner = bedrockClient().beta.messages.toolRunner({
        model: config.bedrock.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        max_iterations: config.maxAgentIterations,
        system: [
          {
            type: 'text',
            text: `${ORCHESTRATOR_SYSTEM}\n\nWhat this platform already ships:\n${JSON.stringify(
              PLATFORM_CAPABILITIES,
              null,
              2,
            )}\n\nKnown gaps:\n${JSON.stringify(PLATFORM_GAPS, null, 2)}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools,
        messages: [
          {
            role: 'user',
            content: [
              `Request from ${request.requester}:`,
              '',
              request.intent,
              ...(request.service ? ['', `This concerns the existing service: ${request.service}`] : []),
            ].join('\n'),
          },
        ],
      });

      for await (const message of runner) {
        span.addEvent('orchestrator turn', { stop_reason: message.stop_reason ?? 'unknown' });
      }
      const plan = await runner.done();
      const planSummary = plan.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      audit.record('orchestrator', 'generation complete', {
        agentsInvoked: changeSets.map((set) => set.agent),
        files: changeSets.reduce((total, set) => total + set.files.length, 0),
      });

      deps.store.update(request.id, { status: 'evaluating', audit: [...audit.entries()] });
      const evaluation = await evaluate(request, changeSets, audit);
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

      const pullRequests = await openPullRequests(request, changeSets, evaluation, audit);
      audit.record('orchestrator', 'run complete', {
        pullRequests: pullRequests.map((pr) => pr.url),
        planSummary,
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
      deps.store.update(request.id, { status: 'failed', error: message, audit: [...audit.entries()] });
      span.recordException(error as Error);
      span.setAttribute('outcome', 'failed');
    } finally {
      span.end();
    }
  });
}
