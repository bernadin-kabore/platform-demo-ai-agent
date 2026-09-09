import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

import type { AuditTrail } from '../audit.js';
import type { ProposedFile, SubAgentName } from '../agents/types.js';
import * as github from '../github.js';
import type { RepoGrant, RequestScope } from '../scope.js';
import { readDenial, writeDenial, writePathDenial } from '../scope.js';
import { capabilityBriefing } from './capabilities.js';

/**
 * The complete set of things a sub-agent can do. There are five, and only one
 * of them changes anything — and even that one only appends to an in-memory
 * array. No tool in this file writes to GitHub, to AWS, or to the cluster.
 *
 * That is the whole design. The agent cannot take an action the platform's
 * existing gates do not already cover, because the only action it can take is
 * "propose a file", and a proposed file becomes real only by travelling
 * through a pull request that CI scans, policy checks, `terraform plan`
 * previews, and a human approves.
 *
 * What changed when requests became service-scoped: authorization is no longer
 * a constant on the specialist's definition but a per-request grant map built
 * in src/scope.ts, consulted separately for reading and for writing. Every
 * refusal is recorded rather than merely returned, because a denial is the most
 * interesting event a run can produce — it is the evidence that the boundary is
 * real, and the thing a reviewer most wants to see if the agent was asked to
 * cross it.
 */
export interface ToolContext {
  agent: SubAgentName;
  /** Effective grants for this specialist on this request. */
  grants: Map<string, RepoGrant>;
  /** The request's immutable authorization scope, for phrasing refusals well. */
  scope: RequestScope;
  audit: AuditTrail;
  /** Files the sub-agent has proposed so far. Mutated by propose_file_change. */
  proposals: ProposedFile[];
  /** Things the sub-agent decided a human must settle. Mutated by raise_open_question. */
  openQuestions: string[];
  /** Authorization refusals this specialist hit. Mutated by the assertions below. */
  denials: string[];
  /**
   * Files this specialist has actually read, by `repo/path`, with the contents
   * it saw. Two jobs: the eval gate refuses a whole-file replacement of a file
   * the agent never read, and the recorded base lets it measure how much of
   * that file the proposal really changed.
   */
  readFiles: Map<string, string | null>;
}

class Denied extends Error {}

function assertReadable(context: ToolContext, repo: string): void {
  const grant = context.grants.get(repo);
  if (grant?.read) return;
  const message = readDenial(repo, context.scope, context.grants);
  context.denials.push(message);
  context.audit.record(context.agent, 'denied repository read', { repo, reason: message });
  throw new Denied(message);
}

function assertWritable(context: ToolContext, repo: string): void {
  const grant = context.grants.get(repo);
  if (grant?.write) return;
  const message = writeDenial(repo, context.agent, context.grants);
  context.denials.push(message);
  context.audit.record(context.agent, 'denied repository write', { repo, reason: message });
  throw new Denied(message);
}

/**
 * The second half of a write authorization, and the one that is new with the
 * application model.
 *
 * A repository grant is no longer sufficient on its own: an application's
 * source repository holds every service its team owns and its GitOps
 * repository holds every service's deployment state, so "may write
 * checkout-platform-gitops" would authorize changing a sibling service that a
 * different team is on call for. RequestScope decides; this function is only
 * the call site that fails closed on its answer.
 */
function assertWritablePath(context: ToolContext, repo: string, path: string): void {
  if (context.scope.isWritablePath(repo, path)) return;
  const message = writePathDenial(repo, path, context.agent, context.scope);
  context.audit.record(context.agent, 'denied out-of-scope path write', { repo, path, reason: message });
  throw new Error(message);
}

export function buildTools(context: ToolContext) {
  const platformContext = betaZodTool({
    name: 'platform_context',
    description:
      'Return what this platform already provides — the capabilities a service can consume, how each one is requested, and the gaps that genuinely do not exist yet. Call this FIRST, before proposing anything. Proposing a capability the platform already ships is the single most common failure mode for this task.',
    inputSchema: z.object({}),
    run: async () => {
      context.audit.record(context.agent, 'read platform context');
      return capabilityBriefing();
    },
  });

  const whatCanIChange = betaZodTool({
    name: 'what_can_i_change',
    description:
      'Return exactly which repositories you may read and which you may change on this request, and why. Call this before proposing a file if you are unsure where a change belongs — it is cheaper than having a proposal refused.',
    inputSchema: z.object({}),
    run: async () => {
      const grants = [...context.grants.values()];
      return JSON.stringify(
        {
          request: context.scope.describe(),
          readable: grants.filter((grant) => grant.read).map((grant) => grant.repo),
          writable: grants
            .filter((grant) => grant.write)
            .map((grant) => ({ repo: grant.repo, why: grant.reason })),
          note:
            'This list is fixed for the whole request and cannot be widened. If the change you want belongs somewhere not listed here, put it in your summary rather than trying another path to it.',
        },
        null,
        2,
      );
    },
  });

  const listRepoTree = betaZodTool({
    name: 'list_repo_tree',
    description:
      'List the files and directories directly under a path in a repository you are authorized for, at its default branch. Use this to find the existing pattern before writing anything new.',
    inputSchema: z.object({
      repo: z.string().describe('Repository name, e.g. platform-demo-gitops'),
      path: z.string().describe('Directory path within the repository. Use "" for the repository root.'),
    }),
    run: async ({ repo, path }) => {
      assertReadable(context, repo);
      const entries = await github.listTree(repo, path);
      context.audit.record(context.agent, 'listed repository tree', {
        repo,
        path,
        entries: entries.length,
      });
      return entries.length ? entries.join('\n') : `(nothing at ${repo}/${path})`;
    },
  });

  const readRepoFile = betaZodTool({
    name: 'read_repo_file',
    description:
      'Read one file from a repository you are authorized for, at its default branch. Read the neighbouring files before you write: this platform has strong conventions and a change that ignores them is a change a reviewer rejects. You must read a file before proposing a change to it.',
    inputSchema: z.object({
      repo: z.string().describe('Repository name, e.g. platform-demo-terraform-modules'),
      path: z.string().describe('File path within the repository'),
    }),
    run: async ({ repo, path }) => {
      assertReadable(context, repo);
      const contents = await github.readFile(repo, path);
      context.readFiles.set(`${repo}/${path}`, contents);
      // Deliberately records that a file was read and whether it existed, never
      // what was in it. Repository contents are the bulk of what flows through
      // this agent and the audit trail ships in a pull request body.
      context.audit.record(context.agent, 'read repository file', {
        repo,
        path,
        found: contents !== null,
      });
      return contents ?? `(no file at ${repo}/${path})`;
    },
  });

  const proposeFileChange = betaZodTool({
    name: 'propose_file_change',
    description:
      'Propose the complete new contents of one file. This does not write anything — proposals are collected, evaluated, and only then turned into a pull request a human reviews. Always supply the whole file, never a diff or a fragment, and change only what the request needs: the smallest change that solves the problem is the one most likely to be merged.',
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
      assertWritable(context, repo);
      assertWritablePath(context, repo, path);
      const key = `${repo}/${path}`;
      const existingIndex = context.proposals.findIndex((p) => p.repo === repo && p.path === path);
      const proposal: ProposedFile = {
        repo,
        path,
        contents,
        rationale,
        // undefined means "never read it", which the eval gate treats
        // differently from null, which means "read it, and it does not exist".
        baseContents: context.readFiles.has(key) ? context.readFiles.get(key) : undefined,
      };
      if (existingIndex >= 0) {
        context.proposals[existingIndex] = proposal;
      } else {
        context.proposals.push(proposal);
      }
      context.audit.record(context.agent, 'proposed file change', {
        repo,
        path,
        bytes: contents.length,
        readFirst: context.readFiles.has(key),
      });
      const warning = context.readFiles.has(key)
        ? ''
        : ` You have not read ${key}. If it already exists, this proposal replaces it wholesale and the eval gate will refuse it — read it first, then propose it back with only your change applied.`;
      return `Recorded a proposal for ${key} (${contents.length} bytes). It is not written yet.${warning}`;
    },
  });

  const raiseOpenQuestion = betaZodTool({
    name: 'raise_open_question',
    description:
      'Record something you could not settle yourself and that the human reviewer must decide — a missing platform capability, an ambiguous requirement, a cost or blast-radius tradeoff, a value you had to guess. Use this instead of inventing an answer. Questions appear prominently on the pull request.',
    inputSchema: z.object({
      question: z
        .string()
        .describe('The question, phrased so a reviewer can answer it without re-reading the whole diff.'),
    }),
    run: async ({ question }) => {
      context.openQuestions.push(question);
      context.audit.record(context.agent, 'raised open question', { question });
      return 'Recorded. It will be shown to the reviewer on the pull request.';
    },
  });

  return [
    platformContext,
    whatCanIChange,
    listRepoTree,
    readRepoFile,
    proposeFileChange,
    raiseOpenQuestion,
  ];
}
