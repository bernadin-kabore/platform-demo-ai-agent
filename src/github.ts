import { App } from 'octokit';
import type { Octokit } from 'octokit';

import { config } from './config.js';
import type { AuditTrail } from './audit.js';
import type { ChangeSet, PlatformRequest } from './agents/types.js';
import type { EvalReport } from './evals/harness.js';

// The agent authenticates as a GitHub App installation, not a personal access
// token, for the same reason the scaffolded services' update-manifests job
// does (see platform-demo-hello-world-template's ci.yml): the credential is a
// short-lived installation token scoped to the repositories the App is
// installed on, and it is attributable in the audit log to the App rather than
// to a human.
//
// What this App is deliberately NOT granted: the ability to merge, to approve
// its own pull requests, or to bypass a ruleset. `platform-deploy-bot` has a
// bypass actor entry on scaffolded repos so CI can push image-tag bumps; this
// App has none anywhere. Its entire reach into the world is "open a pull
// request against a protected branch", which is why human approval remains a
// real gate rather than a formality.
let installationClient: Promise<Octokit> | undefined;

function client(): Promise<Octokit> {
  installationClient ??= (async () => {
    const app = new App({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
    });
    return app.getInstallationOctokit(config.github.installationId);
  })();
  return installationClient;
}

/** Read one file from a platform repository at the base branch. */
export async function readFile(repo: string, path: string): Promise<string | null> {
  const octokit = await client();
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo,
      path,
      ref: config.github.baseBranch,
    });
    const data = response.data;
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return null;
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** List the entries directly under a directory in a platform repository. */
export async function listTree(repo: string, path: string): Promise<string[]> {
  const octokit = await client();
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo,
      path,
      ref: config.github.baseBranch,
    });
    const data = response.data;
    if (!Array.isArray(data)) return [];
    return data.map((entry) => `${entry.type === 'dir' ? 'dir  ' : 'file '}${entry.path}`);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

export interface OpenedPullRequest {
  repo: string;
  url: string;
}

/**
 * One pull request per target repository. The branch name carries the request
 * id so a reviewer can correlate three PRs across three repos back to the one
 * developer intent that produced them.
 */
export async function openPullRequests(
  request: PlatformRequest,
  changeSets: ChangeSet[],
  evaluation: EvalReport,
  audit: AuditTrail,
): Promise<OpenedPullRequest[]> {
  const octokit = await client();
  const byRepo = new Map<string, ChangeSet[]>();
  for (const changeSet of changeSets) {
    for (const file of changeSet.files) {
      const existing = byRepo.get(file.repo) ?? [];
      if (!existing.includes(changeSet)) existing.push(changeSet);
      byRepo.set(file.repo, existing);
    }
  }

  const opened: OpenedPullRequest[] = [];
  for (const [repo, sets] of byRepo) {
    const branch = `ai-agent/${request.id}`;
    const files = sets.flatMap((set) => set.files).filter((file) => file.repo === repo);

    const { data: base } = await octokit.rest.repos.getBranch({
      owner: config.github.owner,
      repo,
      branch: config.github.baseBranch,
    });

    await octokit.rest.git.createRef({
      owner: config.github.owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: base.commit.sha,
    });

    for (const file of files) {
      // Read the existing blob's sha so an update is an update rather than a
      // rejected create. A file the agent invented has no sha and is created.
      const existing = await octokit.rest.repos
        .getContent({ owner: config.github.owner, repo, path: file.path, ref: branch })
        .catch(() => null);
      const sha =
        existing && !Array.isArray(existing.data) && 'sha' in existing.data
          ? existing.data.sha
          : undefined;

      await octokit.rest.repos.createOrUpdateFileContents({
        owner: config.github.owner,
        repo,
        path: file.path,
        branch,
        message: `ai-agent(${request.id}): ${file.rationale.split('\n')[0]}`,
        content: Buffer.from(file.contents, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      });
    }

    const { data: pr } = await octokit.rest.pulls.create({
      owner: config.github.owner,
      repo,
      head: branch,
      base: config.github.baseBranch,
      title: `AI Platform Agent: ${truncate(request.intent, 60)}`,
      body: pullRequestBody(request, sets, evaluation, audit),
    });

    await octokit.rest.issues.addLabels({
      owner: config.github.owner,
      repo,
      issue_number: pr.number,
      labels: ['ai-generated', 'needs-human-approval'],
    });

    audit.record('github', 'opened pull request', { repo, url: pr.html_url });
    opened.push({ repo, url: pr.html_url });
  }

  return opened;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pullRequestBody(
  request: PlatformRequest,
  sets: ChangeSet[],
  evaluation: EvalReport,
  audit: AuditTrail,
): string {
  return [
    '## Generated by the AI Platform Agent',
    '',
    `**Request** \`${request.id}\` from **${request.requester}**:`,
    '',
    `> ${request.intent.replace(/\n/g, '\n> ')}`,
    '',
    '**This pull request has not been reviewed by a human.** It has passed the',
    'automated eval suite below; the CI checks on this branch (policy, security,',
    "and — on Terraform changes — `terraform plan`) run next, and this repository's",
    'branch protection requires an approving review before it can merge. The agent',
    'holds no bypass on that ruleset and cannot approve or merge its own work.',
    '',
    '### What each agent changed',
    '',
    ...sets.flatMap((set) => [
      `#### \`${set.agent}\` agent`,
      '',
      set.summary,
      '',
      ...set.files.map((file) => `- \`${file.path}\` — ${file.rationale}`),
      '',
      ...(set.openQuestions.length
        ? ['**Open questions for the reviewer:**', '', ...set.openQuestions.map((q) => `- ${q}`), '']
        : []),
    ]),
    '### Automated evaluation',
    '',
    evaluation.toMarkdown(),
    '',
    '<details><summary>Agent audit trail</summary>',
    '',
    audit.toMarkdown(),
    '',
    '</details>',
  ].join('\n');
}
