// Loaded before anything else via `node --import ./dist/tracing.js` (see the
// Dockerfile ENTRYPOINT), matching the pattern every scaffolded service uses.
// Endpoints and resource attributes come from OTEL_* environment variables the
// Deployment injects — the SDK reads them natively.
//
// The agent is a platform component that runs on the platform it manages, so
// its telemetry lands in the same Tempo/Prometheus/Grafana as the services it
// scaffolds. An orchestrator run is one trace; each sub-agent and each Claude
// call is a span underneath it.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 30000,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0));
});
