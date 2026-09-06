import "dotenv/config";
import "./auth-bootstrap";
import { serve } from "@hono/node-server";
import {
  logger,
  initObservability,
  registerEmailQueueJob,
  registerSmsQueueJob,
  startRetentionWorker,
  registerEmailThemeResolver,
} from "agora/server";
import { getRealtimeProvider, closeAllConnections } from "agora/realtime";
import { app, injectWebSocket } from "./app";
import { registerWebhookQueueJob } from "agora/webhooks";
import { startQueueWorker } from "agora/queue";
import { startSessionExpiryWorker } from "./modules/session/expiry";
import { startCreditExpiryWorker } from "./modules/credit/expiry";
import { startReservationSweepWorker } from "./modules/reservation/sweep";
import { startAppUsageSweepWorker } from "./modules/app-usage/retention";
import { resolveChronoEmailTheme } from "./lib/email-theme";

const port = Number(process.env.PORT ?? 8787);

// Initialize optional error tracking / tracing before accepting traffic. No-op
// unless SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT are configured.
await initObservability();

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, msg: `API listening on http://localhost:${info.port}` });
});
// Hooks the underlying HTTP server's "upgrade" event so a websocket handshake
// routes through the full Hono app (auth, CORS, tenant middleware) exactly
// like an ordinary request — see agora/realtime and app.ts's own comment on
// why createNodeWebSocket({ app }) closes over the FULL app, not the /rpc
// sub-app alone.
injectWebSocket(server);

// Register every job type before its queue worker starts polling for it.
registerEmailQueueJob();
registerEmailThemeResolver(resolveChronoEmailTheme);
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

// Chrono: auto-closes sessions past their scheduledEndAt (open-ended
// sessions are never touched). Reuses the same closeSession() the manual
// end route calls — see .ai/plans/chrono/active/sessions/README.md, Phase 4.
const stopSessionExpiryWorker = startSessionExpiryWorker();

// Chrono: sweeps expired-but-not-yet-consumed credit grants — see
// .ai/plans/chrono/active/credits/README.md, Phase 4.
const stopCreditExpiryWorker = startCreditExpiryWorker();

// Chrono: activates due direct reservations, expires unclaimed holds
// (no-show / queue failure), and promotes the next queued member — see
// .ai/plans/chrono/active/reservations-queue-and-self-service/README.md,
// Phase 5.
const stopReservationSweepWorker = startReservationSweepWorker();

// Chrono: force-closes app-usage runs whose device has gone stale (the
// orphaned-run policy) and prunes app-usage rows past the retention window —
// see .ai/plans/chrono/in-progress/app-usage/README.md, Phase 3.
const stopAppUsageSweepWorker = startAppUsageSweepWorker();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopEmailWorker();
    stopSmsWorker();
    stopWebhooksWorker();
    stopRetentionWorker();
    stopSessionExpiryWorker();
    stopCreditExpiryWorker();
    stopReservationSweepWorker();
    stopAppUsageSweepWorker();
    // Graceful realtime shutdown, in order: terminate every open socket in
    // this process (closeAllConnections — actually closes each ws, not just
    // registry bookkeeping), THEN drop every provider channel/listener, THEN
    // stop accepting new HTTP connections. Reversing this order would let a
    // socket receive a stray publish after its own teardown has begun.
    void closeAllConnections()
      .then(() => getRealtimeProvider().close())
      .finally(() => {
        server.close(() => process.exit(0));
      });
  });
}
