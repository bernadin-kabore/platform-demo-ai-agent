import { trace } from '@opentelemetry/api';
import pino from 'pino';

// Trace-correlated JSON on stdout, exactly like every scaffolded service: the
// OpenTelemetry log agent's filelog receiver promotes trace_id/span_id to
// first-class log-record IDs, which is what lets Grafana pivot from an agent
// error straight to the Claude call that produced it. See
// platform-demo-gitops/docs/observability/README.md.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
});
