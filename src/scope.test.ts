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
 */
const VALID: ServiceContext = {
  entityRef: 'component:default/checkout-api',
  name: 'checkout-api',
  repo: 'checkout-api',
  owner: 'group:default/checkout-team',
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
  // The smuggling guard. A Component whose project-slug annotation points at a
  // platform repository would otherwise turn an application request into write
  // access to the cluster's source of truth — and that annotation lives in a
  // file the requesting team controls.
  assert.throws(
    () =>
      validateServiceContext(
        { ...VALID, repo: 'platform-demo-gitops' },
        'checkout-team',
      ),
    (error: unknown) => error instanceof ScopeDenied && /platform repository/.test(error.message),
  );
});

test('malformed or missing fields deny rather than defaulting', () => {
  const cases: [string, unknown][] = [
    ['not an object', 'checkout-api'],
    ['null', null],
    ['bad entity reference', { ...VALID, entityRef: 'checkout-api' }],
    ['entity reference for the wrong kind', { ...VALID, entityRef: 'group:default/checkout-api' }],
    ['repository name with a path separator', { ...VALID, repo: 'org/checkout-api' }],
    ['repository name with a traversal', { ...VALID, repo: '../platform-demo-gitops' }],
    ['empty owner', { ...VALID, owner: '   ' }],
    ['missing name', { ...VALID, name: '' }],
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
  assert.equal(scope.applicationRepo, undefined);
  assert.equal(scope.isApplicationRepo('checkout-api'), false);
});

test('a service scope reaches exactly one application repository', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  assert.equal(scope.applicationRepo, 'checkout-api');
  assert.equal(scope.isApplicationRepo('checkout-api'), true);
  assert.equal(scope.isApplicationRepo('payments-api'), false);
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

  // Application owns a service's configuration and may change it.
  assert.equal(grantsFor(SUB_AGENTS.application, scope).get('checkout-api')?.write, true);
  assert.equal(grantsFor(SUB_AGENTS.observability, scope).get('checkout-api')?.write, true);

  // Security and Terraform can diagnose inside the service's repository and
  // cannot fix things there — that change belongs to the Application domain.
  const security = grantsFor(SUB_AGENTS.security, scope).get('checkout-api');
  assert.equal(security?.read, true);
  assert.equal(security?.write, false);

  const terraform = grantsFor(SUB_AGENTS.terraform, scope).get('checkout-api');
  assert.equal(terraform?.read, true);
  assert.equal(terraform?.write, false);
});

test('a specialist with no application access does not see the repository at all', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  const grants = grantsFor(
    { platformRepos: ['platform-demo-gitops'], applicationRepoAccess: 'none' },
    scope,
  );
  assert.equal(grants.has('checkout-api'), false);
});

test('no other team’s repository is ever granted, whatever the scope', () => {
  const scope = RequestScope.forService(VALID, 'checkout-team');
  for (const definition of Object.values(SUB_AGENTS)) {
    const grants = grantsFor(definition, scope);
    assert.equal(grants.has('payments-api'), false, `${definition.name} must not reach payments-api`);
  }
});
