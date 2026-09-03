import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';

const app = createServer();

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, model: config.bedrock.model, region: config.bedrock.region },
    'AI Platform Agent listening',
  );
});

// Istio's sidecar and the Rollout's canary analysis both assume a pod stops
// accepting work before it disappears. Draining in-flight requests here is the
// difference between a clean canary step and a handful of 503s attributed to
// the new revision.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
