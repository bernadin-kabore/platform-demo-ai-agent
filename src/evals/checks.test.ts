import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChangeSet } from '../agents/types.js';
import { runDeterministicChecks } from './checks.js';

function changeSet(files: ChangeSet['files']): ChangeSet[] {
  return [{ agent: 'security', files, summary: 'test', openQuestions: [] }];
}

const compliantDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: example
        team: platform-team
    spec:
      containers:
        - name: example
          image: 382334305409.dkr.ecr.us-east-1.amazonaws.com/example:abc123
          livenessProbe: { httpGet: { path: /healthz, port: 8080 } }
          readinessProbe: { httpGet: { path: /readyz, port: 8080 } }
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
`;

test('a compliant Deployment passes the admission pre-flight', () => {
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: compliantDeployment, rationale: 'r' }]),
  );
  assert.equal(
    results.filter((r) => !r.passed && r.blocking).length,
    0,
    JSON.stringify(results.filter((r) => !r.passed), null, 2),
  );
});

test('a Deployment missing probes is blocked before it reaches admission', () => {
  const withoutProbes = compliantDeployment
    .replace(/\s+livenessProbe: .*\n/, '\n')
    .replace(/\s+readinessProbe: .*\n/, '\n');
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: withoutProbes, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/require-probes' && !r.passed && r.blocking));
});

test('a :latest tag is blocked', () => {
  const latest = compliantDeployment.replace('example:abc123', 'example:latest');
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/deployment.yaml', contents: latest, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/disallow-latest-tag' && !r.passed));
});

test('unparseable YAML is blocked', () => {
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-gitops', path: 'apps/x/broken.yaml', contents: 'a:\n  - b\n c: [', rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'yaml-parses' && !r.passed && r.blocking));
});

test('a comment key inside an IAM policy document is blocked — this defect reached a real apply', () => {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    _comment: 'why this policy exists — em dash and all',
    Statement: [{ Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::example'] }],
  });
  const results = runDeterministicChecks(
    changeSet([
      { repo: 'platform-demo-terraform-modules', path: 'envs/dev/policies/example.json', contents: policy, rationale: 'r' },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'terraform/no-comments-in-policy-json' && !r.passed && r.blocking));
});

test('a hand-rolled IRSA trust policy is blocked in favour of modules/irsa', () => {
  const tf = `
resource "aws_iam_role" "thing" {
  name = "thing"
  assume_role_policy = jsonencode({
    Statement = [{ Action = "sts:AssumeRoleWithWebIdentity", Effect = "Allow" }]
  })
}
`;
  const results = runDeterministicChecks(
    changeSet([{ repo: 'platform-demo-terraform-modules', path: 'envs/dev/main.tf', contents: tf, rationale: 'r' }]),
  );
  assert.ok(results.some((r) => r.check === 'terraform/use-irsa-module' && !r.passed && r.blocking));
});

test('a Kyverno policy without an explicit failure action is blocked', () => {
  const policy = `
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: example
  annotations:
    policies.kyverno.io/severity: medium
spec:
  rules: []
`;
  const results = runDeterministicChecks(
    changeSet([
      { repo: 'platform-demo-gitops', path: 'apps/kyverno/policies/example.yaml', contents: policy, rationale: 'r' },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'kyverno/policy-action' && !r.passed));
});

test('a credential in a proposed file is blocked', () => {
  const results = runDeterministicChecks(
    changeSet([
      {
        repo: 'platform-demo-gitops',
        path: 'apps/x/secret.yaml',
        contents: 'key: AKIAIOSFODNN7EXAMPLE\n',
        rationale: 'r',
      },
    ]),
  );
  assert.ok(results.some((r) => r.check === 'no-secrets' && !r.passed && r.blocking));
});

test('an empty run is blocked — there is nothing to review', () => {
  const results = runDeterministicChecks([]);
  assert.ok(results.some((r) => r.check === 'produced-changes' && !r.passed && r.blocking));
});

test('an unreviewably large run is blocked', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    repo: 'platform-demo-gitops' as const,
    path: `apps/x/file-${i}.yaml`,
    contents: 'a: 1\n',
    rationale: 'r',
  }));
  const results = runDeterministicChecks(changeSet(files));
  assert.ok(results.some((r) => r.check === 'reviewable-size' && !r.passed && r.blocking));
});
