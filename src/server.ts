import { randomUUID } from 'node:crypto';

import express, { type Express } from 'express';

import type { PlatformRequest } from './agents/types.js';
import { logger } from './logger.js';
import { handleRequest } from './orchestrator.js';
import { RequestScope, ScopeDenied, validateServiceContext } from './scope.js';
import { RequestStore } from './store.js';

/**
 * The HTTP surface Backstage talks to. Four routes, and only one of them does
 * anything: everything else is the portal asking how a run is going.
 *
 * Requests are accepted and processed asynchronously because an orchestrator
 * run takes minutes, not milliseconds — the scaffolder action fires this and
 * returns a link, rather than holding a form open while four specialists read
 * repositories.
 */
export function createServer(store = new RequestStore()): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness is separate from liveness on purpose: this process is ready as
  // soon as it can serve, and its dependencies (Bedrock, GitHub) are checked
  // per request rather than at startup. A dependency outage should surface as
  // a failed run with a clear error, not as a pod that silently never becomes
  // ready and gets rolled back by the Rollout's analysis.
  app.get('/readyz', (_req, res) => {
    res.json({ status: 'ready' });
  });

  // Where the authorization boundary is drawn, and the only place it is drawn.
  //
  // The scope is resolved here, before the request is stored and long before a
  // model sees the text, and it is immutable afterwards. Everything downstream
  // — the classifier, the specialists, the tools — reads from it and none of
  // them can add to it. A request that cannot be scoped is refused with 403
  // rather than accepted and narrowed later, because "accepted, then narrowed"
  // is the shape in which authorization bugs hide.
  app.post('/v1/requests', (req, res) => {
    const { intent, requester, serviceContext } = req.body ?? {};
    if (typeof intent !== 'string' || intent.trim().length < 10) {
      res.status(400).json({
        error:
          'intent is required and must be at least 10 characters — describe what you want in a sentence or two.',
      });
      return;
    }
    if (typeof requester !== 'string' || !requester.trim()) {
      res.status(400).json({ error: 'requester is required so the pull request records who asked.' });
      return;
    }

    // serviceContext is present exactly when the developer selected a service
    // in the portal. Backstage resolves the Component and its owner from the
    // catalog; this re-validates every field of that resolution, including the
    // ownership comparison, so a compromised portal cannot mint access to a
    // repository the requesting team does not own.
    let scope: RequestScope;
    try {
      scope =
        serviceContext === undefined || serviceContext === null
          ? RequestScope.platformOnly(requester.trim())
          : RequestScope.forService(validateServiceContext(serviceContext, requester.trim()), requester.trim());
    } catch (error) {
      if (error instanceof ScopeDenied) {
        logger.warn(
          { requester, reason: error.reason, detail: error.detail },
          'refused a platform request at the authorization boundary',
        );
        res.status(403).json({ error: error.reason, detail: error.detail });
        return;
      }
      throw error;
    }

    const request: PlatformRequest = {
      id: randomUUID().slice(0, 8),
      intent: intent.trim(),
      requester: requester.trim(),
      ...(scope.service ? { service: scope.service } : {}),
      createdAt: new Date().toISOString(),
    };

    store.create(request);
    logger.info(
      {
        requestId: request.id,
        requester: request.requester,
        entityRef: scope.service?.entityRef,
        applicationRepo: scope.applicationRepo,
      },
      'accepted platform request',
    );

    // Fire and forget: handleRequest records its own failures into the store,
    // so an unhandled rejection here would be a bug rather than a normal path.
    void handleRequest(request, { store, scope }).catch((error) => {
      logger.error({ err: error, requestId: request.id }, 'orchestrator threw outside its own handler');
    });

    res.status(202).json({ id: request.id, status: 'accepted' });
  });

  app.get('/v1/requests/:id', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: `No request ${req.params.id}` });
      return;
    }
    res.json(serialize(record));
  });

  app.get('/v1/requests', (_req, res) => {
    res.json(store.list().map(serialize));
  });

  return app;
}

function serialize(record: ReturnType<RequestStore['get']> & {}) {
  return {
    ...record,
    // The plan is the portal's headline: it is what the developer reads to see
    // whether the platform understood them, and it exists even when the run
    // produced nothing.
    plan: record.plan,
    // The eval report is a class; the portal wants its rendered form and its
    // headline numbers, not its methods.
    evaluation: record.evaluation
      ? {
          passed: record.evaluation.passed,
          score: record.evaluation.judge.score,
          threshold: record.evaluation.threshold,
          blockingFailures: record.evaluation.blockingFailures,
          markdown: record.evaluation.toMarkdown(),
        }
      : undefined,
    // Proposed file contents can be large and the portal only shows paths.
    changeSets: record.changeSets.map((set) => ({
      agent: set.agent,
      summary: set.summary,
      openQuestions: set.openQuestions,
      denials: set.denials,
      files: set.files.map((file) => ({ repo: file.repo, path: file.path, rationale: file.rationale })),
    })),
  };
}
