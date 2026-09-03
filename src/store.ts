import type { PlatformRequest, RequestRecord } from './agents/types.js';

/**
 * In-memory request state, so the portal can poll a run while it happens.
 *
 * Deliberately not a database. Nothing here is a source of truth: the durable
 * record of what the agent did is the pull request it opened, which lives in
 * Git and outlives any pod. Losing this map on a restart loses the progress
 * indicator for in-flight runs and nothing else, which is the right amount of
 * durability for what it holds. A run interrupted by a restart is visible as a
 * branch with no pull request on it — the same failure mode any CI job has.
 */
export class RequestStore {
  readonly #records = new Map<string, RequestRecord>();

  create(request: PlatformRequest): RequestRecord {
    const record: RequestRecord = {
      request,
      status: 'accepted',
      changeSets: [],
      pullRequests: [],
      audit: [],
    };
    this.#records.set(request.id, record);
    return record;
  }

  update(id: string, patch: Partial<Omit<RequestRecord, 'request'>>): void {
    const existing = this.#records.get(id);
    if (!existing) return;
    this.#records.set(id, { ...existing, ...patch });
  }

  get(id: string): RequestRecord | undefined {
    return this.#records.get(id);
  }

  list(): RequestRecord[] {
    return [...this.#records.values()].sort((a, b) =>
      b.request.createdAt.localeCompare(a.request.createdAt),
    );
  }
}
