import { trace } from '@opentelemetry/api';

import type { AuditTrail } from '../audit.js';
import { bedrockClient } from '../bedrock.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildTools } from '../tools/repo.js';
import type { ChangeSet, ProposedFile, SubAgentDefinition } from './types.js';

const tracer = trace.getTracer('ai-platform-agent');

/**
 * Runs one sub-agent to completion and returns its change set.
 *
 * The loop is the SDK's tool runner rather than a hand-written
 * request/execute/re-request cycle, iterated one turn at a time so every turn
 * can be traced and audited. Two Bedrock-specific notes:
 *
 *   - `strict: true` tool schemas are not available here (structured outputs
 *     are unsupported on Bedrock), so tool inputs are validated by Zod on our
 *     side, in `betaZodTool`, rather than by the server.
 *   - The tool runner reaches Claude through the SDK's beta namespace. If a
 *     future Bedrock endpoint change makes that path unavailable, the
 *     replacement is the manual loop documented in the README — the tools and
 *     their handlers are unchanged by that swap, because they are plain
 *     functions.
 */
export async function runSubAgent(
  definition: SubAgentDefinition,
  task: string,
  audit: AuditTrail,
): Promise<ChangeSet> {
  return tracer.startActiveSpan(`subagent.${definition.name}`, async (span) => {
    const proposals: ProposedFile[] = [];
    const openQuestions: string[] = [];
    const tools = buildTools({
      agent: definition.name,
      allowedRepos: definition.allowedRepos,
      audit,
      proposals,
      openQuestions,
    });

    audit.record(definition.name, 'sub-agent started', { task });

    try {
      const runner = bedrockClient().beta.messages.toolRunner({
        model: config.bedrock.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        max_iterations: config.maxAgentIterations,
        system: [
          {
            type: 'text',
            text: definition.systemPrompt,
            // The system prompt and tool list are byte-stable across every run
            // of this sub-agent, so they are the cache prefix; the task, which
            // differs per request, comes after it in the first user message.
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools,
        messages: [{ role: 'user', content: task }],
      });

      let turns = 0;
      for await (const message of runner) {
        turns += 1;
        span.addEvent('turn', {
          turn: turns,
          stop_reason: message.stop_reason ?? 'unknown',
          output_tokens: message.usage.output_tokens,
        });
        logger.debug(
          { agent: definition.name, turn: turns, stop_reason: message.stop_reason },
          'sub-agent turn',
        );
      }

      const final = await runner.done();
      const summary = final.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();

      audit.record(definition.name, 'sub-agent finished', {
        turns,
        files: proposals.length,
        openQuestions: openQuestions.length,
        stopReason: final.stop_reason,
      });

      // A run that ends because it ran out of iterations has not finished
      // thinking, and shipping its half-formed proposals as though it had is
      // exactly the kind of silent failure that erodes trust in the whole
      // pipeline. Surface it to the reviewer instead.
      if (final.stop_reason === 'max_tokens' || turns >= config.maxAgentIterations) {
        openQuestions.push(
          `The ${definition.name} agent hit its iteration or token ceiling before finishing. Treat this change set as incomplete.`,
        );
      }

      span.setAttribute('proposals', proposals.length);
      return { agent: definition.name, files: proposals, summary, openQuestions };
    } finally {
      span.end();
    }
  });
}
