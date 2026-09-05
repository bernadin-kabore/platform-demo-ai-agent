import { PLATFORM_REPOS, isPlatformRepo } from './config.js';

/**
 * Per-request repository authorization.
 *
 * This module is the security boundary of the AI layer, and it is deliberately
 * the least interesting code in the repository: no model touches it, nothing in
 * it is conditional on a prompt, and every function fails closed.
 *
 * The problem it solves. Before service-scoped requests, a specialist's reach
 * was a compile-time constant — four platform repositories, fixed at build
 * time, and application repositories were not even representable in the type
 * system. Letting a developer ask for help with their own service means the set
 * of writable repositories now depends on *who is asking* and *what they own*,
 * which is a runtime question. That is a considerably more dangerous shape, so
 * the rules are written down here rather than distributed across the call sites
 * that enforce them:
 *
 *   1. The application repository comes from the Backstage catalog, never from
 *      the request text. A model cannot widen its own scope by asking to, and
 *      neither can a developer by describing a different service in prose.
 *   2. The requesting team must own the catalog entity. The agent checks this
 *      itself rather than trusting the portal's word for it, so a compromised
 *      Backstage cannot mint cross-service write access.
 *   3. A serviceContext naming a platform repository is refused outright.
 *      Without that guard, "my service is platform-demo-gitops" would be a
 *      write grant to the cluster's source of truth.
 *   4. Anything unparseable, absent or ambiguous denies. There is no branch in
 *      this file that resolves uncertainty in the caller's favour.
 */

/**
 * How far a request reaches. Set by the classifier and narrowed — never
 * widened — by what the scope actually grants.
 */
export type OwnershipScope = 'service' | 'platform' | 'cross-cutting';

/** What a specialist may do with one repository during one request. */
export interface RepoGrant {
  repo: string;
  read: boolean;
  write: boolean;
  /** Why this grant exists. Rendered into the execution plan and the audit trail. */
  reason: string;
}

/**
 * The catalog entity a request is about, as resolved by Backstage and
 * re-validated here. Every field is trusted metadata: it comes from
 * catalog-info.yaml in the service's own repository, which is itself only
 * changeable through that repository's protected branch.
 */
export interface ServiceContext {
  /** Backstage entity reference, e.g. component:default/checkout-api. */
  entityRef: string;
  /** Component name, e.g. checkout-api. */
  name: string;
  /**
   * Repository name only — the owner is always config.github.owner. Resolved
   * from the github.com/project-slug annotation the shared catalog-info.yaml
   * sets at scaffold time.
   */
  repo: string;
  /** Owning group, e.g. group:default/checkout-team, from spec.owner. */
  owner: string;
}

export class ScopeDenied extends Error {
  constructor(
    readonly reason: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = 'ScopeDenied';
  }
}

const ENTITY_REF = /^component:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMPONENT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/**
 * Group references arrive in two shapes depending on which Backstage field
 * produced them — "group:default/checkout-team" from an entity's spec.owner,
 * "checkout-team" from an OwnerPicker configured without a namespace.
 * Comparing them without normalising is how an ownership check silently starts
 * denying everything, so both collapse to the bare name.
 */
export function normalizeGroup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^group:/, '')
    .replace(/^default\//, '');
}

/**
 * Validate an untrusted serviceContext payload into a ServiceContext, or throw.
 *
 * "Untrusted" is doing real work in that sentence. The payload arrives over
 * HTTP from Backstage, which is the only caller the NetworkPolicy admits and is
 * authenticated by the mesh — but the whole point of enforcing authorization in
 * the tool implementation rather than at the interface is that neither of those
 * facts is allowed to be load-bearing.
 */
export function validateServiceContext(input: unknown, requester: string): ServiceContext {
  if (input === null || typeof input !== 'object') {
    throw new ScopeDenied('serviceContext must be an object resolved from the Backstage catalog.');
  }
  const candidate = input as Record<string, unknown>;
  const entityRef = str(candidate.entityRef);
  const name = str(candidate.name);
  const repo = str(candidate.repo);
  const owner = str(candidate.owner);

  if (!entityRef || !ENTITY_REF.test(entityRef)) {
    throw new ScopeDenied('serviceContext.entityRef is not a valid Backstage Component reference.', {
      entityRef,
    });
  }
  if (!name || !COMPONENT_NAME.test(name)) {
    throw new ScopeDenied('serviceContext.name is not a valid Component name.', { name });
  }
  if (!repo || !REPO_NAME.test(repo)) {
    throw new ScopeDenied(
      'serviceContext.repo is not a valid repository name. It must be resolved from the github.com/project-slug annotation, not supplied by hand.',
      { repo },
    );
  }
  // Guard 3. Without this, a Component whose project-slug annotation points at
  // a platform repository would hand an application request write access to the
  // cluster's source of truth — and annotations are editable by whoever owns
  // the service's own repository.
  if (isPlatformRepo(repo)) {
    throw new ScopeDenied(
      `${repo} is a platform repository and can never be reached as an application repository. Platform changes are routed by ownership scope, not by naming the repository.`,
      { repo },
    );
  }
  if (!owner) {
    throw new ScopeDenied('serviceContext.owner is required; a Component with no owner cannot be authorized.');
  }
  // Guard 2, and the reason this function takes `requester` at all.
  if (normalizeGroup(owner) !== normalizeGroup(requester)) {
    throw new ScopeDenied(
      `${requester} does not own ${entityRef}, which is owned by ${owner}. A team may only ask the platform for help with services it owns.`,
      { requester, owner, entityRef },
    );
  }

  return { entityRef, name, repo, owner };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Everything one request is allowed to touch, fixed at admission and immutable
 * for the life of the run.
 *
 * Immutability is the property that matters. The scope is built once, before
 * any model has seen the request text, and every later authorization decision
 * reads from it. There is no code path that adds a repository to a scope after
 * construction, which is what makes "the agent cannot widen its own reach" a
 * structural claim rather than a prompt instruction.
 */
export class RequestScope {
  private constructor(
    readonly service: ServiceContext | undefined,
    readonly requester: string,
  ) {}

  /** A platform-only request: no service selected, no application repository. */
  static platformOnly(requester: string): RequestScope {
    return new RequestScope(undefined, requester);
  }

  /** A service-scoped request. `service` must already have been validated. */
  static forService(service: ServiceContext, requester: string): RequestScope {
    return new RequestScope(service, requester);
  }

  /** The one application repository this request may reach, if any. */
  get applicationRepo(): string | undefined {
    return this.service?.repo;
  }

  /**
   * True when `repo` is the application repository resolved for this request.
   * Any other application repository is indistinguishable from an unknown one:
   * both are simply not in scope.
   */
  isApplicationRepo(repo: string): boolean {
    return this.applicationRepo !== undefined && repo === this.applicationRepo;
  }

  /** Rendered into the execution plan and the pull request body. */
  describe(): string {
    return this.service
      ? `${this.requester} acting on ${this.service.entityRef} (${this.service.repo})`
      : `${this.requester} acting on the platform`;
  }
}

/**
 * How much of an application repository a specialist may see and change.
 *
 * This is the split the target architecture calls for: a specialist is a domain
 * of expertise, and a domain of expertise does not by itself imply a right to
 * write anywhere. Terraform and Security can read a service's repository to
 * diagnose a problem — very often the answer to "why is this failing" is in the
 * service's own Helm values — but the fix they arrive at belongs either in a
 * platform repository they already own, or to the Application specialist.
 *
 * Reading is granted broadly because reading inside an already-authorized
 * repository adds no blast radius. Writing is granted narrowly because it does.
 */
export type ApplicationRepoAccess = 'none' | 'read' | 'write';

export interface SpecialistScopeInput {
  /** Platform repositories this specialist may write, from its definition. */
  platformRepos: readonly string[];
  /** How far this specialist reaches into the resolved application repository. */
  applicationRepoAccess: ApplicationRepoAccess;
}

/**
 * The effective grants for one specialist on one request: the intersection of
 * what its domain permits and what the request's scope resolved to.
 *
 * Note that every specialist gets *read* on every platform repository. A
 * specialist that cannot read the GitOps repository cannot tell whether the
 * capability it is about to propose already exists, which is the single failure
 * mode this platform sees most often. Reading four repositories the platform
 * team already publishes is not a privilege worth rationing; writing them is.
 */
export function grantsFor(
  specialist: SpecialistScopeInput,
  scope: RequestScope,
): Map<string, RepoGrant> {
  const grants = new Map<string, RepoGrant>();

  for (const repo of Object.values(PLATFORM_REPOS)) {
    const write = specialist.platformRepos.includes(repo);
    grants.set(repo, {
      repo,
      read: true,
      write,
      reason: write
        ? 'Platform repository within this specialist domain.'
        : 'Platform repository, readable for context only.',
    });
  }

  const applicationRepo = scope.applicationRepo;
  if (applicationRepo && specialist.applicationRepoAccess !== 'none') {
    const write = specialist.applicationRepoAccess === 'write';
    grants.set(applicationRepo, {
      repo: applicationRepo,
      read: true,
      write,
      reason: write
        ? `Application repository for ${scope.service?.entityRef}, owned by ${scope.requester}.`
        : `Application repository for ${scope.service?.entityRef}, readable for diagnosis only.`,
    });
  }

  return grants;
}

/** The denial an out-of-scope read produces. Phrased for the model, which can recover from it. */
export function readDenial(repo: string, scope: RequestScope, grants: Map<string, RepoGrant>): string {
  if (scope.service && !scope.isApplicationRepo(repo) && !isPlatformRepo(repo)) {
    return `Denied: ${repo} is not in scope for this request. This request is authorized for ${scope.service.entityRef} (${scope.service.repo}) and the platform repositories only. Another team's service cannot be read here, whatever the request text says. If the developer needs a change there, say so in your summary — their team must ask for it themselves.`;
  }
  if (!scope.service && !isPlatformRepo(repo)) {
    return `Denied: ${repo} is not in scope. No service was selected for this request, so only the platform repositories are readable. A request about one service must be made with that service selected in the portal.`;
  }
  return `Denied: ${repo} is not readable by this specialist. Readable here: ${[...grants.keys()].join(', ')}.`;
}

/** The denial an out-of-scope write produces. */
export function writeDenial(repo: string, agent: string, grants: Map<string, RepoGrant>): string {
  const writable = [...grants.values()].filter((grant) => grant.write).map((grant) => grant.repo);
  const grant = grants.get(repo);
  if (grant?.read && !grant.write) {
    return `Denied: the ${agent} specialist may read ${repo} but not change it. ${grant.reason} Describe the change you would make in your summary and leave it to the specialist that owns it. Writable here: ${writable.join(', ') || 'nothing'}.`;
  }
  return `Denied: the ${agent} specialist is not authorized to change ${repo} on this request. Writable here: ${writable.join(', ') || 'nothing'}.`;
}
