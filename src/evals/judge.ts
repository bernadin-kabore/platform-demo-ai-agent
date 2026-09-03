import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

import type { ChangeSet, PlatformRequest } from '../agents/types.js';
import { bedrockClient } from '../bedrock.js';
import { config } from '../config.js';
import { PLATFORM_CAPABILITIES } from '../tools/platformContext.js';

/**
 * The second eval layer: a rubric the deterministic checks cannot express.
 *
 * "Did this actually answer what was asked" and "does this match how the rest
 * of the repository is written" are real review criteria and no regular
 * expression captures them. What a judge is not is a safety control — it
 * shares a failure mode with the model that produced the change, so it can
 * only ever *lower* a verdict the deterministic checks already permitted.
 *
 * Bedrock does not support structured outputs, so the verdict comes back as a
 * forced tool call with a JSON schema rather than via output_config.format.
 * The judge is given no other tool, so a completed turn is a verdict.
 */
const VerdictSchema = z.object({
  answersTheRequest: z
    .number()
    .min(0)
    .max(1)
    .describe('Does the change set actually do what was asked? 0 = unrelated, 1 = fully addresses it.'),
  followsConventions: z
    .number()
    .min(0)
    .max(1)
    .describe('Does it match the platform conventions it was given? 0 = ignores them, 1 = indistinguishable from hand-written platform code.'),
  avoidsRebuilding: z
    .number()
    .min(0)
    .max(1)
    .describe('Does it avoid re-implementing capabilities the platform already ships? 1 = reuses what exists.'),
  reviewability: z
    .number()
    .min(0)
    .max(1)
    .describe('Could a reviewer understand and check this in a few minutes? Penalise sprawl and unexplained changes.'),
  honestyAboutGaps: z
    .number()
    .min(0)
    .max(1)
    .describe('Did it raise the things it genuinely could not know, rather than inventing plausible values?'),
  blockingConcerns: z
    .array(z.string())
    .describe('Concrete reasons this should not become a pull request. Empty if there are none.'),
  reasoning: z.string().describe('Two or three sentences a human reviewer will read on the pull request.'),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export interface JudgeResult extends Verdict {
  score: number;
}

const RUBRIC_WEIGHTS: Record<keyof Omit<Verdict, 'blockingConcerns' | 'reasoning'>, number> = {
  answersTheRequest: 0.3,
  followsConventions: 0.25,
  avoidsRebuilding: 0.2,
  reviewability: 0.15,
  honestyAboutGaps: 0.1,
};

const SYSTEM = `
You are reviewing a change set that an AI agent produced for an Internal
Developer Platform, before any human sees it. You are the last automated gate.

You are not the author's advocate. Assume the change is wrong until the diff
shows otherwise, and score what is actually in front of you rather than what
the summary claims. A confident summary attached to a change that does not do
what it says is the specific failure you exist to catch.

Score each rubric dimension from 0 to 1. Use the whole range: 0.5 means
genuinely mediocre, not "I am unsure". Reserve 1.0 for work you would merge
without comment.

Raise a blocking concern only for something that should stop the pull request
from being opened at all — a change that would break a running system, weaken a
security control without saying so, or address a different problem than the one
asked about. Style disagreements are not blocking concerns; put those in your
reasoning.
`.trim();

export async function judgeChangeSet(
  request: PlatformRequest,
  changeSets: ChangeSet[],
): Promise<JudgeResult> {
  let verdict: Verdict | undefined;

  const submitVerdict = betaZodTool({
    name: 'submit_verdict',
    description: 'Submit your scored verdict. Call this exactly once, when you have finished reviewing.',
    inputSchema: VerdictSchema,
    run: async (input) => {
      verdict = input;
      return 'Verdict recorded.';
    },
  });

  const runner = bedrockClient().beta.messages.toolRunner({
    model: config.bedrock.judgeModel,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    max_iterations: 4,
    system: [
      {
        // Stable prefix: rubric plus the platform inventory. The change set,
        // which differs on every call, follows it in the user message.
        type: 'text',
        text: `${SYSTEM}\n\nWhat this platform already ships:\n${JSON.stringify(PLATFORM_CAPABILITIES, null, 2)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [submitVerdict],
    tool_choice: { type: 'tool', name: 'submit_verdict' },
    messages: [{ role: 'user', content: renderForReview(request, changeSets) }],
  });

  for await (const _message of runner) {
    // Iterated to completion; the verdict is captured by the tool handler.
  }

  if (!verdict) {
    // A judge that produced no verdict is not a pass. Score it zero and let
    // the threshold reject the run rather than defaulting open.
    return {
      answersTheRequest: 0,
      followsConventions: 0,
      avoidsRebuilding: 0,
      reviewability: 0,
      honestyAboutGaps: 0,
      blockingConcerns: ['The evaluation judge did not return a verdict, so this change set is unreviewed.'],
      reasoning: 'No verdict was produced.',
      score: 0,
    };
  }

  const score = (Object.keys(RUBRIC_WEIGHTS) as (keyof typeof RUBRIC_WEIGHTS)[]).reduce(
    (total, dimension) => total + verdict![dimension] * RUBRIC_WEIGHTS[dimension],
    0,
  );

  return { ...verdict, score };
}

function renderForReview(request: PlatformRequest, changeSets: ChangeSet[]): string {
  const sections = changeSets.flatMap((set) => [
    `## ${set.agent} agent`,
    '',
    `Summary it gave: ${set.summary}`,
    '',
    set.openQuestions.length
      ? `Open questions it raised:\n${set.openQuestions.map((q) => `- ${q}`).join('\n')}`
      : 'It raised no open questions.',
    '',
    ...set.files.flatMap((file) => [
      `### \`${file.repo}/${file.path}\``,
      `Rationale: ${file.rationale}`,
      '',
      '```',
      file.contents,
      '```',
      '',
    ]),
  ]);

  return [
    'The developer asked for:',
    '',
    request.intent,
    '',
    '---',
    '',
    'The agents produced the following. Review it and call submit_verdict.',
    '',
    ...sections,
  ].join('\n');
}
