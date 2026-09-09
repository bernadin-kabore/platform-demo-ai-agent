import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SUB_AGENTS } from './agents/index.js';
import {
  RequestScope,
  ScopeDenied,
  grantsFor,
  normalizeGroup,
  validateServiceContext,
  type ServiceContext,
} from './scope.js';

/**
 * Tests for the authorization boundary.
 *
 * Every case here is a denial except two, which is the right ratio for a file
 * whose job is to say no. The one property worth stating explicitly: there is
 * no test asserting that some input *widens* a scope, because there is no code
 * path that can. If a future change adds one, the reviewer should ask why.
 *
 * The application model made this file's job larger in one specific way. A
 * request used to resolve to one repository that held exactly one service, so
 * "authorized for checkout-api" and "authorized for this service" were the same
 * sentence. Now an application's source repository holds every service its team
 * owns and its GitOps repository holds every service's deployment state, so the
 * repository grant is no longer the boundary — the path is. Most of what is new
 * below is that distinction.
 */
const VALID: ServiceContext = {
  entityRef: 'component:default/checkout-platform-auth',
  name: 'checkout-platform-auth',
  application: 'checkout-platform',
  owner: 'group:default/checkout-team',
  sourceRepo: 'checkout-platform-source',
  sourcePath: 'services/auth',
  gitopsRepo: 'checkout-platform-gitops',
  gitopsService: 'auth',
};

test('a well-formed serviceContext owned by the requester is accepted', () => {
  const resolved = validateServiceContext({ ...VALID }, 'checkout-team');
  assert.deepEqual(resolved, VALID);
});

test('group references normalise across the shapes Backstage produces', () => {
  // spec.owner gives "group:default/checkout-team"; an OwnerPicker configured
  // without a namespace gives "checkout-team". Both name the same team, and
  // comparing them naively would deny every legitimate request.
  assert.equal(normalizeGroup('group:default/checkout-team'), 'checkout-team');
  assert.equal(normalizeGroup('Checkout-Team'), 'checkout-team');
  assert.equal(normalizeGroup('default/checkout-team'), 'checkout-team');
});

test('a team may not act on a service another team owns', () => {
  assert.throws(
    () => validateServiceContext({ ...VALID }, 'payments-team'),
    (error: unknown) => error instanceof ScopeDenied && /does not own/.test(error.message),
  );
});

test('a serviceContext naming a platform repository is refused outright', () => {
  // The smuggling guard, now doubled because there are two repositories to
  // smuggle through. A Component whose annotations point at a platform
  // repository would otherwise turn an application request into write access to
  // the cluster's source of truth — and those annotations live in a file the
  // requesting team controls.
  for (const field of ['sourceRepo', 'gitopsRepo'] as const) {
    assert.throws(
      () => validateServiceContext({ ...VALID, [field]: 'platform-demo-gitops' }, 'checkout-team'),
      (error: unknown) => error instanceof ScopeDenied && /platform repository/.test(error.message),
      `expected ${field} naming a platform repository to be denied`,
    );
  }
});

test('a serviceContext claiming one repository is both source and GitOps is refused', () => {
  // The separation between code and deployment state is what the whole
  // application model exists to create. Collapsing the two would give
  // source-path write access to deployment state.
  assert.throws(
    () =>
      validateServiceContext(
        { ...VALID, gitopsRepo: 'checkout-platform-source' },
        'checkout-team',
      ),
    (error: unknown) => error instanceof ScopeDenied && /separate repositories/.test(error.message),
  );
});

test('malformed or missing fields deny rather than defaulting', () => {
  const cases: [string, unknown][] = [
    ['not an object', 'checkout-platform-auth'],
    ['null', null],
    ['bad entity reference', { ...VALID, entityRef: 'checkout-platform-auth' }],
    ['entity reference for the wrong kind', { ...VALID, entityRef: 'group:default/checkout-auth' }],
    ['source repository with a path separator', { ...VALID, sourceRepo: 'org/checkout-source' }],
    ['source repository with a traversal', { ...VALID, sourceRepo: '../platform-demo-gitops' }],
    ['gitops repository with a traversal', { ...VALID, gitopsRepo: '../platform-demo-gitops' }],
    ['empty owner', { ...VALID, owner: '   ' }],
    ['missing name', { ...VALID, name: '' }],
    ['missing application', { ...VALID, application: '' }],
    // The path fields are what make a scope narrower than a repository, so
    // they are held to the same standard as the repository names.
    ['source path outside services/', { ...VALID, sourcePath: '.github/workflows' }],
    ['source path at the repository root', { ...VALID, sourcePath: '' }],
    ['source path with a traversal', { ...VALID, sourcePath: 'services/../.github' }],
    ['source path reaching a sibling', { ...VALID, sourcePath: 'services/auth/../payments' }],
    ['gitops service with a separator', { ...VALID, gitopsService: 'environments/dev' }],
    ['gitops service with a traversal', { ...VALID, gitopsService: '..' }],
  ];
  for (const [description, input] of cases) {
    assert.throws(
      () => validateServiceContext(input, 'checkout-team'),
      ScopeDenied,
      `expected "${description}" to be denied`,
    );
  }
});

test('a platform-only scope reaches no application repository', () => {
  const scope = RequestScope.platformOnly('platform-team');
  assert.deepEqual(scope.applicationRepos, []);
  assert.equal(scope.isApplicationRepo('checkout-platform-source'), false);
});

test('a service scope reaches exactly the two repositories of its application', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  assert.equal(scope.sourceRepo, 'checkout-platform-source');
  assert.equal(scope.gitopsRepo, 'checkout-platform-gitops');
  assert.equal(scope.isApplicationRepo('checkout-platform-source'), true);
  assert.equal(scope.isApplicationRepo('checkout-platform-gitops'), true);
  assert.equal(scope.isApplicationRepo('payments-platform-source'), false);
});

test('a service may be written only inside its own directory in the source repository', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const source = 'checkout-platform-source';

  assert.equal(scope.isWritablePath(source, 'services/auth/src/index.js'), true);
  assert.equal(scope.isWritablePath(source, 'services/auth/Dockerfile'), true);

  // A sibling service in the same repository. This is the case the path rule
  // exists for: the repository grant alone would have allowed it.
  assert.equal(scope.isWritablePath(source, 'services/payments/src/index.js'), false);
  // A service whose name merely starts with this one's.
  assert.equal(scope.isWritablePath(source, 'services/auth-proxy/src/index.js'), false);
  // Shared by every service in the application.
  assert.equal(scope.isWritablePath(source, 'platform.yaml'), false);
  assert.equal(scope.isWritablePath(source, '.github/workflows/ci.yml'), false);
  assert.equal(scope.isWritablePath(source, 'catalog-info.yaml'), false);
  // The service's own directory, but not a file in it.
  assert.equal(scope.isWritablePath(source, 'services/auth'), false);
});

test('a service may be written only in its own deployment-state files', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const gitops = 'checkout-platform-gitops';

  for (const environment of ['dev', 'staging', 'prod']) {
    assert.equal(
      scope.isWritablePath(gitops, `environments/${environment}/services/auth.yaml`),
      true,
      `${environment} should be writable`,
    );
  }

  // Another service's deployment state.
  assert.equal(scope.isWritablePath(gitops, 'environments/dev/services/payments.yaml'), false);
  // Shared by every service in the application.
  assert.equal(scope.isWritablePath(gitops, 'environments/dev/env-values.yaml'), false);
  assert.equal(scope.isWritablePath(gitops, 'chart/values.yaml'), false);
  assert.equal(scope.isWritablePath(gitops, 'chart/templates/rollout.yaml'), false);
  assert.equal(scope.isWritablePath(gitops, 'argocd/applicationset.yaml'), false);
  // Right name, wrong shape.
  assert.equal(scope.isWritablePath(gitops, 'environments/dev/services/auth.yml'), false);
  assert.equal(scope.isWritablePath(gitops, 'environments/dev/services/auth.yaml.bak'), false);
});

test('path traversal does not escape a service, whatever shape it arrives in', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const source = 'checkout-platform-source';
  const traversals = [
    'services/auth/../payments/src/index.js',
    'services/auth/./../../platform.yaml',
    '/services/auth/src/index.js',
    'services\\auth\\src\\index.js',
    'services//auth/src/index.js',
    '',
    '   ',
  ];
  for (const path of traversals) {
    assert.equal(scope.isWritablePath(source, path), false, `expected "${path}" to be refused`);
  }
});

test('a platform repository has no path restriction', () => {
  // A specialist writing a platform repository is acting as the platform, not
  // as one service, so there is nothing to narrow it to.
  const scope = RequestScope.forService(VALID, 'checkout-team');
  assert.equal(scope.isWritablePath('platform-demo-gitops', 'apps/kyverno/policies/anything.yaml'), true);
});

test('every specialist may read all four platform repositories', () => {
  // Reading them adds no blast radius and withholding them causes the failure
  // this platform sees most: proposing a capability that already exists.
  const scope = RequestScope.platformOnly('platform-team');
  for (const definition of Object.values(SUB_AGENTS)) {
    const grants = grantsFor(definition, scope);
    const readable = [...grants.values()].filter((grant) => grant.read).map((grant) => grant.repo);
    assert.ok(readable.includes('platform-demo-gitops'), `${definition.name} should read gitops`);
    assert.ok(readable.includes('platform-demo-terraform-modules'), `${definition.name} should read terraform`);
  }
});

test('a specialist may write only the platform repositories in its own domain', () => {
  const scope = RequestScope.platformOnly('platform-team');

  const terraform = grantsFor(SUB_AGENTS.terraform, scope);
  assert.equal(terraform.get('platform-demo-terraform-modules')?.write, true);
  assert.equal(terraform.get('platform-demo-gitops')?.write, false);

  const security = grantsFor(SUB_AGENTS.security, scope);
  assert.equal(security.get('platform-demo-gitops')?.write, true);
  assert.equal(security.get('platform-demo-terraform-modules')?.write, false);
});

test('expertise and repository ownership are separate: read on an app repo is not write', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');

  // Application and Observability own a service's configuration and its code,
  // and may change both. Where those changes may land is a path question,
  // tested above; this is only about which repositories are writable at all.
  for (const agent of ['application', 'observability'] as const) {
    const grants = grantsFor(SUB_AGENTS[agent], scope);
    assert.equal(grants.get('checkout-platform-source')?.write, true, `${agent} should write source`);
    assert.equal(grants.get('checkout-platform-gitops')?.write, true, `${agent} should write gitops`);
  }

  // Security and Terraform can diagnose inside both repositories and cannot fix
  // anything in either — that change belongs to the Application domain.
  for (const agent of ['security', 'terraform'] as const) {
    const grants = grantsFor(SUB_AGENTS[agent], scope);
    for (const repo of ['checkout-platform-source', 'checkout-platform-gitops']) {
      assert.equal(grants.get(repo)?.read, true, `${agent} should read ${repo}`);
      assert.equal(grants.get(repo)?.write, false, `${agent} must not write ${repo}`);
    }
  }
});

test('a specialist with no application access does not see either repository', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const grants = grantsFor(
    { platformRepos: ['platform-demo-gitops'], sourceAccess: 'none', gitopsAccess: 'none' },
    scope,
  );
  assert.equal(grants.has('checkout-platform-source'), false);
  assert.equal(grants.has('checkout-platform-gitops'), false);
});

test('the two application repositories are granted independently', () => {
  // A specialist that may change how a service is deployed is not thereby one
  // that may change what it does. Nothing in grantsFor couples them.
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const grants = grantsFor(
    { platformRepos: [], sourceAccess: 'read', gitopsAccess: 'write' },
    scope,
  );
  assert.equal(grants.get('checkout-platform-source')?.write, false);
  assert.equal(grants.get('checkout-platform-gitops')?.write, true);
});

test('no other team’s repository is ever granted, whatever the scope', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  for (const definition of Object.values(SUB_AGENTS)) {
    const grants = grantsFor(definition, scope);
    assert.equal(
      grants.has('payments-platform-source'),
      false,
      `${definition.name} must not reach payments-platform-source`,
    );
    assert.equal(
      grants.has('payments-platform-gitops'),
      false,
      `${definition.name} must not reach payments-platform-gitops`,
    );
  }
});
