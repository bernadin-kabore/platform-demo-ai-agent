import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

import type { AuditTrail } from '../audit.js';
import type { PlatformRepo } from '../config.js';
import type { ProposedFile, SubAgentName } from '../agents/types.js';
import * as github from '../github.js';
import { PLATFORM_CAPABILITIES, PLATFORM_GAPS } from './platformContext.js';

/**
 * The complete set of things a sub-agent can do. There are four, and only one
 * of them changes anything — and even that one only appends to an in-memory
 * array. No tool in this file writes to GitHub, to AWS, or to the cluster.
 *
 * That is the whole design. The agent cannot take an action the platform's
 * existing gates do not already cover, because the only action it can take is
 * "propose a file", and a proposed file becomes real only by travelling
 * through a pull request that CI scans, policy checks, `terraform plan`
 * previews, and a human approves.
 */
export interface ToolContext {
  agent: SubAgentName;
  allowedRepos: readonly PlatformRepo[];
  audit: AuditTrail;
  /** Files the sub-agent has proposed so far. Mutated by propose_file_change. */
  proposals: ProposedFile[];
  /** Things the sub-agent decided a human must settle. Mutated by raise_open_question. */
  openQuestions: string[];
}

function assertAllowed(context: ToolContext, repo: string): asserts repo is PlatformRepo {
  if (!context.allowedRepos.includes(repo as PlatformRepo)) {
    // Returned to the model as a tool error rather than thrown, so it can
    // recover by routing the work to the right agent instead of the run dying.
    throw new Error(
      `The ${context.agent} agent may not touch ${repo}. It is scoped to: ${context.allowedRepos.join(
        ', ',
      )}. If this change belongs in ${repo}, say so in your summary and leave it to the agent that owns it.`,
    );
  }
}

export function buildTools(context: ToolContext) {
  const platformContext = betaZodTool({
    name: 'platform_context',
    description:
      'Return what this platform already has and what it is genuinely missing. Call this FIRST, before proposing anything. Proposing a capability the platform already ships is the single most common failure mode for this task.',
    inputSchema: z.object({}),
    run: async () => {
      context.audit.record(context.agent, 'read platform context');
      return JSON.stringify({ alreadyBuilt: PLATFORM_CAPABILITIES, knownGaps: PLATFORM_GAPS }, null, 2);
    },
  });

  const listRepoTree = betaZodTool({
    name: 'list_repo_tree',
    description:
      'List the files and directories directly under a path in one of the platform repositories, at the default branch. Use this to find the existing pattern before writing anything new.',
    inputSchema: z.object({
      repo: z.string().describe('Repository name, e.g. platform-demo-gitops'),
      path: z.string().describe('Directory path within the repository. Use "" for the repository root.'),
    }),
    run: async ({ repo, path }) => {
      assertAllowed(context, repo);
      const entries = await github.listTree(repo, path);
      context.audit.record(context.agent, 'listed repository tree', { repo, path, entries: entries.length });
      return entries.length ? entries.join('\n') : `(nothing at ${repo}/${path})`;
    },
  });

  const readRepoFile = betaZodTool({
    name: 'read_repo_file',
    description:
      'Read one file from a platform repository at the default branch. Read the neighbouring files before you write: this platform has strong conventions and a change that ignores them is a change a reviewer rejects.',
    inputSchema: z.object({
      repo: z.string().describe('Repository name, e.g. platform-demo-terraform-modules'),
      path: z.string().describe('File path within the repository'),
    }),
    run: async ({ repo, path }) => {
      assertAllowed(context, repo);
      const contents = await github.readFile(repo, path);
      context.audit.record(context.agent, 'read repository file', { repo, path, found: contents !== null });
      return contents ?? `(no file at ${repo}/${path})`;
    },
  });

  const proposeFileChange = betaZodTool({
    name: 'propose_file_change',
    description:
      'Propose the complete new contents of one file. This does not write anything — proposals are collected, evaluated, and only then turned into a pull request a human reviews. Always supply the whole file, never a diff or a fragment.',
    inputSchema: z.object({
      repo: z.string().describe('Repository the file belongs to'),
      path: z.string().describe('File path within the repository'),
      contents: z.string().describe('The complete new contents of the file'),
      rationale: z
        .string()
        .describe(
          'One or two sentences on why this file changes, written for the reviewer who will read it on the pull request.',
        ),
    }),
    run: async ({ repo, path, contents, rationale }) => {
      assertAllowed(context, repo);
      const existingIndex = context.proposals.findIndex((p) => p.repo === repo && p.path === path);
      const proposal: ProposedFile = { repo, path, contents, rationale };
      if (existingIndex >= 0) {
        context.proposals[existingIndex] = proposal;
      } else {
        context.proposals.push(proposal);
      }
      context.audit.record(context.agent, 'proposed file change', { repo, path, bytes: contents.length });
      return `Recorded a proposal for ${repo}/${path} (${contents.length} bytes). It is not written yet.`;
    },
  });

  const raiseOpenQuestion = betaZodTool({
    name: 'raise_open_question',
    description:
      'Record something you could not settle yourself and that the human reviewer must decide — a missing platform capability, an ambiguous requirement, a cost or blast-radius tradeoff, a value you had to guess. Use this instead of inventing an answer. Questions appear prominently on the pull request.',
    inputSchema: z.object({
      question: z.string().describe('The question, phrased so a reviewer can answer it without re-reading the whole diff.'),
    }),
    run: async ({ question }) => {
      context.openQuestions.push(question);
      context.audit.record(context.agent, 'raised open question', { question });
      return 'Recorded. It will be shown to the reviewer on the pull request.';
    },
  });

  return [platformContext, listRepoTree, readRepoFile, proposeFileChange, raiseOpenQuestion];
}
