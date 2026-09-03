import { randomUUID } from 'node:crypto';

import express, { type Express } from 'express';

import type { PlatformRequest } from './agents/types.js';
import { logger } from './logger.js';
import { handleRequest } from './orchestrator.js';
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

  app.post('/v1/requests', (req, res) => {
    const { intent, requester, service } = req.body ?? {};
    if (typeof intent !== 'string' || intent.trim().length < 10) {
      res.status(400).json({
        error: 'intent is required and must be at least 10 characters — describe what you want in a sentence or two.',
      });
      return;
    }
    if (typeof requester !== 'string' || !requester.trim()) {
      res.status(400).json({ error: 'requester is required so the pull request records who asked.' });
      return;
    }

    const request: PlatformRequest = {
      id: randomUUID().slice(0, 8),
      intent: intent.trim(),
      requester: requester.trim(),
      ...(typeof service === 'string' && service.trim() ? { service: service.trim() } : {}),
      createdAt: new Date().toISOString(),
    };

    store.create(request);
    logger.info({ requestId: request.id, requester: request.requester }, 'accepted platform request');

    // Fire and forget: handleRequest records its own failures into the store,
    // so an unhandled rejection here would be a bug rather than a normal path.
    void handleRequest(request, { store }).catch((error) => {
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
      files: set.files.map((file) => ({ repo: file.repo, path: file.path, rationale: file.rationale })),
    })),
  };
}
