import "dotenv/config";
import "./auth-bootstrap";
import { serve } from "@hono/node-server";
import {
  logger,
  initObservability,
  registerEmailQueueJob,
  registerSmsQueueJob,
  startRetentionWorker,
} from "agora/server";
import { app } from "./app";
import { registerWebhookQueueJob } from "agora/webhooks";
import { startQueueWorker } from "agora/queue";

const port = Number(process.env.PORT ?? 8787);

// Initialize optional error tracking / tracing before accepting traffic. No-op
// unless SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT are configured.
await initObservability();

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, msg: `API listening on http://localhost:${info.port}` });
});

// Register every job type before its queue worker starts polling for it.
registerEmailQueueJob();
registerSmsQueueJob();
registerWebhookQueueJob();

// Email/SMS retries + outbound webhook delivery run in-process alongside the
// HTTP server, one poller per named queue (agora/queue).
const stopEmailWorker = startQueueWorker("email");
const stopSmsWorker = startQueueWorker("sms");
const stopWebhooksWorker = startQueueWorker("webhooks");

// Daily data-retention sweep: prunes old job rows + audit events per
// .ai/plans/agora/active/data-retention/README.md.
const stopRetentionWorker = startRetentionWorker();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopEmailWorker();
    stopSmsWorker();
    stopWebhooksWorker();
    stopRetentionWorker();
    server.close(() => process.exit(0));
  });
}
