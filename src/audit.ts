import { logger } from './logger.js';

/**
 * Every action the agent takes, in order. This is not a debug log — it is the
 * evidence a human reviewer reads on the pull request to decide whether the
 * change was arrived at sensibly, and it is what the eval harness scores
 * process against outcome on.
 *
 * It is append-only by construction: `record` returns void and there is no
 * mutation path back into a run's entries.
 */
export interface AuditEntry {
  at: string;
  requestId: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export class AuditTrail {
  readonly #entries: AuditEntry[] = [];

  constructor(private readonly requestId: string) {}

  record(actor: string, action: string, detail: Record<string, unknown> = {}): void {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      requestId: this.requestId,
      actor,
      action,
      detail,
    };
    this.#entries.push(entry);
    logger.info({ audit: entry }, `${actor}: ${action}`);
  }

  entries(): readonly AuditEntry[] {
    return [...this.#entries];
  }

  /** Rendered into the pull request body so the reasoning ships with the diff. */
  toMarkdown(): string {
    const rows = this.#entries.map(
      (e) =>
        `| ${e.at} | \`${e.actor}\` | ${e.action} | ${
          Object.keys(e.detail).length ? `\`${JSON.stringify(e.detail)}\`` : ''
        } |`,
    );
    return ['| When | Actor | Action | Detail |', '|---|---|---|---|', ...rows].join('\n');
  }
}
