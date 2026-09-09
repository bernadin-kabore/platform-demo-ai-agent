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
 *   5. A service-scoped request is scoped to a *path*, not only a repository.
 *      An application's source repository holds every service its team owns,
 *      and its GitOps repository holds every service's deployment state — so
 *      "authorized for checkout-platform-source" would authorize writing a
 *      sibling service that a different team is on call for. What the request
 *      may write is derived from the catalog's source-path and
 *      gitops-service annotations, and derived once, here.
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
  /** Backstage entity reference, e.g. component:default/checkout-platform-auth. */
  entityRef: string;
  /** Component name, e.g. checkout-platform-auth. */
  name: string;
  /** The System this service belongs to, e.g. checkout-platform. */
  application: string;
  /** Owning group, e.g. group:default/checkout-team, from spec.owner. */
  owner: string;
  /**
   * Repository name only — the owner is always config.github.owner. Every
   * service in the application shares it, which is exactly why sourcePath
   * exists.
   */
  sourceRepo: string;
  /** This service's directory within the source repository, e.g. services/auth. */
  sourcePath: string;
  /** The application's GitOps repository, e.g. checkout-platform-gitops. */
  gitopsRepo: string;
  /**
   * This service's key within the GitOps repository, e.g. auth. Its deployment
   * state is environments/<environment>/services/<gitopsService>.yaml, one file
   * per environment. The convention lives in gitopsServicePath() below rather
   * than in an annotation, so a stale annotation cannot widen a scope.
   */
  gitopsService: string;
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
 * A service's directory in an application source repository. Anchored, with no
 * dots and no second slash, so it can express `services/auth` and cannot
 * express `services/../.github` or `services/auth/../payments`.
 */
const SOURCE_PATH = /^services\/[a-z0-9][a-z0-9-]{0,62}$/;

/** A service's key in a GitOps repository. One path segment, nothing else. */
const GITOPS_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  const application = str(candidate.application);
  const owner = str(candidate.owner);
  const sourceRepo = str(candidate.sourceRepo);
  const sourcePath = str(candidate.sourcePath);
  const gitopsRepo = str(candidate.gitopsRepo);
  const gitopsService = str(candidate.gitopsService);

  if (!entityRef || !ENTITY_REF.test(entityRef)) {
    throw new ScopeDenied('serviceContext.entityRef is not a valid Backstage Component reference.', {
      entityRef,
    });
  }
  if (!name || !COMPONENT_NAME.test(name)) {
    throw new ScopeDenied('serviceContext.name is not a valid Component name.', { name });
  }
  if (!application || !COMPONENT_NAME.test(application)) {
    throw new ScopeDenied(
      "serviceContext.application is not a valid System name. It comes from the Component's spec.system, which the scaffolder sets and which groups a service with its siblings.",
      { application },
    );
  }
  if (!owner) {
    throw new ScopeDenied('serviceContext.owner is required; a Component with no owner cannot be authorized.');
  }

  // Both repositories, validated identically. Neither may be a platform
  // repository: without this guard a Component annotated
  // "gitops-repo: platform-demo-gitops" would hand an application request
  // write access to the cluster's source of truth, and annotations are
  // editable by whoever owns the application's own repository.
  const validSourceRepo = validateApplicationRepo('sourceRepo', sourceRepo);
  const validGitopsRepo = validateApplicationRepo('gitopsRepo', gitopsRepo);

  if (validSourceRepo === validGitopsRepo) {
    // The separation between code and deployment state is the property the
    // whole application model exists to create. A Component claiming both are
    // the same repository is either a misconfiguration or an attempt to get
    // source-path write access to deployment state.
    throw new ScopeDenied(
      `serviceContext names ${validSourceRepo} as both the source and the GitOps repository. An application's code and its deployment state live in separate repositories.`,
      { sourceRepo: validSourceRepo },
    );
  }

  // Path components. These are the fields that make a scope narrower than a
  // repository, so they are validated as strictly as the repository names —
  // and a traversal here would be a write outside the service's directory.
  if (!sourcePath || !SOURCE_PATH.test(sourcePath)) {
    throw new ScopeDenied(
      `serviceContext.sourcePath must be a service directory of the form services/<name>, and was "${sourcePath ?? ''}". It comes from the platform.acme.io/source-path annotation.`,
      { sourcePath },
    );
  }
  if (!gitopsService || !GITOPS_SERVICE.test(gitopsService)) {
    throw new ScopeDenied(
      `serviceContext.gitopsService must be a plain service key, and was "${gitopsService ?? ''}". It comes from the platform.acme.io/gitops-service annotation.`,
      { gitopsService },
    );
  }

  // Guard 2, and the reason this function takes `requester` at all.
  if (normalizeGroup(owner) !== normalizeGroup(requester)) {
    throw new ScopeDenied(
      `${requester} does not own ${entityRef}, which is owned by ${owner}. A team may only ask the platform for help with services it owns.`,
      { requester, owner, entityRef },
    );
  }

  return {
    entityRef,
    name,
    application,
    owner,
    sourceRepo: validSourceRepo,
    sourcePath,
    gitopsRepo: validGitopsRepo,
    gitopsService,
  };
}

/**
 * One application repository name, validated. Split out so the source and the
 * GitOps repository cannot accidentally be held to different standards — they
 * are equally reachable and equally dangerous to get wrong.
 */
function validateApplicationRepo(field: string, repo: string | undefined): string {
  if (!repo || !REPO_NAME.test(repo)) {
    throw new ScopeDenied(
      `serviceContext.${field} is not a valid repository name. It must be resolved from the catalog annotations, not supplied by hand.`,
      { field, repo },
    );
  }
  if (isPlatformRepo(repo)) {
    throw new ScopeDenied(
      `${repo} is a platform repository and can never be reached as an application repository. Platform changes are routed by ownership scope, not by naming the repository.`,
      { field, repo },
    );
  }
  return repo;
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

  /** The application source repository this request may reach, if any. */
  get sourceRepo(): string | undefined {
    return this.service?.sourceRepo;
  }

  /** The application GitOps repository this request may reach, if any. */
  get gitopsRepo(): string | undefined {
    return this.service?.gitopsRepo;
  }

  /** Both application repositories, for callers that do not care which is which. */
  get applicationRepos(): readonly string[] {
    return this.service ? [this.service.sourceRepo, this.service.gitopsRepo] : [];
  }

  /**
   * True when `repo` is one of the two application repositories resolved for
   * this request. Any other application repository is indistinguishable from an
   * unknown one: both are simply not in scope.
   */
  isApplicationRepo(repo: string): boolean {
    return this.applicationRepos.includes(repo);
  }

  /**
   * Whether `path` in `repo` is inside this request's service.
   *
   * This is rule 5, and it is the reason a service-scoped request is not simply
   * a repository grant. Both application repositories are shared by every
   * service in the application:
   *
   *   - in the source repository, the request owns services/<service>/ and
   *     nothing else. Not platform.yaml, not .github/, not a sibling service —
   *     each of those is either shared by every service or belongs to a team
   *     that is not the one asking.
   *   - in the GitOps repository, the request owns
   *     environments/<any>/services/<service>.yaml and nothing else. Not
   *     env-values.yaml, not chart/, not argocd/ — those change how every
   *     service in the application deploys.
   *
   * Platform repositories have no path restriction: a specialist that may
   * write one at all is writing it as the platform, not as a service.
   */
  isWritablePath(repo: string, path: string): boolean {
    if (!this.service) return isPlatformRepo(repo);
    if (isPlatformRepo(repo)) return true;

    const normalized = normalizePath(path);
    if (normalized === undefined) return false;

    if (repo === this.service.sourceRepo) {
      return normalized.startsWith(`${this.service.sourcePath}/`);
    }
    if (repo === this.service.gitopsRepo) {
      return gitopsServicePath(this.service.gitopsService).test(normalized);
    }
    return false;
  }

  /** Human-readable description of what this request may write where. */
  writablePaths(repo: string): string {
    if (!this.service || isPlatformRepo(repo)) return 'anywhere in the repository';
    if (repo === this.service.sourceRepo) return `${this.service.sourcePath}/**`;
    if (repo === this.service.gitopsRepo) {
      return `environments/<environment>/services/${this.service.gitopsService}.yaml`;
    }
    return 'nothing';
  }

  /** Rendered into the execution plan and the pull request body. */
  describe(): string {
    return this.service
      ? `${this.requester} acting on ${this.service.entityRef} (${this.service.sourcePath} in ${this.service.sourceRepo}, ${this.service.gitopsService} in ${this.service.gitopsRepo})`
      : `${this.requester} acting on the platform`;
  }
}

/**
 * Reject anything that is not a plain forward-slashed relative path before it
 * is compared against a prefix. A prefix check on "services/auth/../../.github"
 * passes while addressing a completely different file, so normalisation is not
 * cosmetic here — it is the check.
 */
function normalizePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  // Backslashes, absolute paths and NULs are all ways of addressing a file
  // that the prefix comparison below would not recognise as escaping the
  // service's own directory.
  if (trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.includes('\0'))
    return undefined;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return segments.join('/');
}

/**
 * Where one service's deployment state lives, as a pattern rather than a
 * literal path: one file per environment, and the set of environments is not
 * something the agent should have to be told.
 *
 * This convention is defined here and nowhere else. It deliberately is not an
 * annotation — an annotation is editable by whoever owns the application's
 * repository, and a scope that reads its own bounds from the thing it is
 * bounding is not a boundary.
 */
function gitopsServicePath(service: string): RegExp {
  return new RegExp(
    `^environments/[a-z0-9][a-z0-9-]{0,30}/services/${escapeRegExp(service)}\\.yaml$`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How much of an application repository a specialist may see and change.
 *
 * This is the split the target architecture calls for: a specialist is a domain
 * of expertise, and a domain of expertise does not by itself imply a right to
 * write anywhere. Terraform and Security can read a service's repositories to
 * diagnose a problem — very often the answer to "why is this failing" is in the
 * service's deployment values — but the fix they arrive at belongs either in a
 * platform repository they already own, or to the Application specialist.
 *
 * Reading is granted broadly because reading inside an already-authorized
 * repository adds no blast radius. Writing is granted narrowly because it does,
 * and it is narrowed twice: by which of the two repositories a specialist may
 * write at all, and then by RequestScope.isWritablePath.
 */
export type ApplicationRepoAccess = 'none' | 'read' | 'write';

export interface SpecialistScopeInput {
  /** Platform repositories this specialist may write, from its definition. */
  platformRepos: readonly string[];
  /**
   * How far this specialist reaches into the application's SOURCE repository —
   * its code, its Dockerfile, its tests.
   */
  sourceAccess: ApplicationRepoAccess;
  /**
   * How far it reaches into the application's GITOPS repository — the service's
   * deployment state. These are separate because they are separate kinds of
   * change: a specialist that should be able to raise a memory limit is not
   * automatically one that should be able to edit the application's code.
   */
  gitopsAccess: ApplicationRepoAccess;
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

  const service = scope.service;
  if (!service) return grants;

  const application: Array<{ repo: string; access: ApplicationRepoAccess; what: string; where: string }> = [
    {
      repo: service.sourceRepo,
      access: specialist.sourceAccess,
      what: 'source',
      where: `${service.sourcePath}/`,
    },
    {
      repo: service.gitopsRepo,
      access: specialist.gitopsAccess,
      what: 'deployment state',
      where: `environments/*/services/${service.gitopsService}.yaml`,
    },
  ];

  for (const entry of application) {
    if (entry.access === 'none') continue;
    const write = entry.access === 'write';
    grants.set(entry.repo, {
      repo: entry.repo,
      read: true,
      write,
      reason: write
        ? `Application ${entry.what} for ${service.entityRef}, owned by ${scope.requester}. Writable only under ${entry.where}.`
        : `Application ${entry.what} for ${service.entityRef}, readable for diagnosis only.`,
    });
  }

  return grants;
}

/** The denial an out-of-scope read produces. Phrased for the model, which can recover from it. */
export function readDenial(repo: string, scope: RequestScope, grants: Map<string, RepoGrant>): string {
  if (scope.service && !scope.isApplicationRepo(repo) && !isPlatformRepo(repo)) {
    return `Denied: ${repo} is not in scope for this request. This request is authorized for ${scope.service.entityRef} (${scope.service.sourceRepo} and ${scope.service.gitopsRepo}) and the platform repositories only. Another team's service cannot be read here, whatever the request text says. If the developer needs a change there, say so in your summary — their team must ask for it themselves.`;
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

/**
 * The denial a write to the right repository but the wrong path produces.
 *
 * Phrased for the model rather than for a log, because this is the denial it
 * will most often hit legitimately: a specialist that correctly identifies a
 * shared file as the cause of a problem is not wrong about the diagnosis, only
 * about who gets to make the change. Telling it what it may write instead is
 * what turns a refusal into a useful summary for the reviewer.
 */
export function writePathDenial(repo: string, path: string, agent: string, scope: RequestScope): string {
  const service = scope.service;
  if (!service) {
    return `Denied: ${repo}/${path} is not writable on a platform-wide request.`;
  }

  if (repo === service.sourceRepo) {
    return `Denied: ${path} is outside ${service.entityRef}'s own directory. This request is authorized for ${service.sourcePath}/ in ${repo} and nothing else — the repository holds every service in ${service.application}, and the rest of them belong to whoever is on call for them. Files shared by all of them (platform.yaml, .github/, shared/) are a platform change, not a service change. If the fix genuinely belongs there, say so in your summary and leave it.`;
  }

  if (repo === service.gitopsRepo) {
    return `Denied: ${path} is not ${service.entityRef}'s deployment state. The ${agent} specialist may write environments/<environment>/services/${service.gitopsService}.yaml here and nothing else. env-values.yaml, chart/ and argocd/ change how every service in ${service.application} deploys, so they are not a service-scoped change however narrow the edit looks.`;
  }

  return `Denied: ${repo}/${path} is not in scope for this request.`;
}
