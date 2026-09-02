import "dotenv/config";

/**
 * Realtime e2e test-publish server (realtime-updates Phase 4,
 * `.ai/plans/chrono/active/realtime-updates/README.md`) — mirrors
 * `apps/agora-api/src/e2e/realtime-test-server.ts` exactly, per
 * websocket-foundation's own "Decision" paragraph: no test-publish HTTP
 * route is ever added — "an env-gated route that can publish into a tenant
 * channel is itself a hole in the one boundary this feature has."
 *
 * The only way to trigger a publish the running server's live sockets will
 * actually receive, without that route, is to run the publish call INSIDE
 * the same Node process as the server handling those sockets — the
 * in-memory `MemoryRealtimeProvider` is a plain process-local `Map`; a
 * separate process's `getRealtimeProvider()` call is a different, empty Map.
 *
 * This boots the real `chrono-api` app (identical to `index.ts`'s own
 * bootstrap, websocket wiring included) and additionally listens on stdin for
 * newline-delimited JSON publish commands:
 *   {"tenantId": "...", "scope": "branch:<id>" | null, "event": "...", "payload": ...}
 * — one call to `getRealtimeProvider().publish(...)` per line, no HTTP
 * involved. Printing `REALTIME_TEST_SERVER_READY <port>` on stdout signals
 * the caller (`apps/chrono-web/e2e/utils/realtime-test-publish.ts`, in the
 * OTHER app — a subprocess boundary is used deliberately here rather than a
 * cross-app source import, since `chrono-web` importing `chrono-api`'s
 * private `src/` would violate `.ai/rules/monorepo.md`'s "apps must not
 * import private files from another app," and `chrono-api` isn't a
 * `packages/agora` subpath export) that it's ready to accept connections and
 * publish commands.
 *
 * This process BINDS THE SAME PORT the developer's own `pnpm dev` `chrono-api`
 * normally uses (`PORT`, default 8787) — `chrono-web`'s `NEXT_PUBLIC_API_URL`
 * is baked in at build time and cannot be repointed at test time, so this
 * script must occupy that exact port for the browser to reach it. Running the
 * realtime e2e specs therefore requires stopping any separately-running
 * `chrono-api` dev process first; this script serves as a drop-in replacement
 * for the duration of the run.
 *
 * IMPORTANT: `registerChronoPermissions()` (the app-permission registration
 * seam) must run before `../app` is imported — `../index.ts`'s own bootstrap
 * imports `./auth-bootstrap` first for exactly this reason, and this script
 * must do the same or `agora/auth`'s registry freezes without Chrono's
 * resources registered.
 */
import "../auth-bootstrap";
import { createInterface } from "node:readline";
import { app, injectWebSocket } from "../app";
import { getRealtimeProvider, tenantChannel, tenantScopeChannel } from "agora/realtime";

type PublishCommand = {
  tenantId: string;
  scope: string | null;
  event: string;
  payload: unknown;
};

function isPublishCommand(v: unknown): v is PublishCommand {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.tenantId === "string" &&
    (r.scope === null || typeof r.scope === "string") &&
    typeof r.event === "string" &&
    "payload" in r
  );
}

async function main() {
  const port = Number(process.env.PORT ?? 8787);
  const { serve } = await import("@hono/node-server");

  const server = serve({ fetch: app.fetch, port }, () => {
    injectWebSocket(server);
    // eslint-disable-next-line no-console
    console.log(`REALTIME_TEST_SERVER_READY ${port}`);
  });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "exit") {
      process.exit(0);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // eslint-disable-next-line no-console
      console.error(`REALTIME_TEST_SERVER_ERROR invalid JSON: ${trimmed}`);
      return;
    }
    if (!isPublishCommand(parsed)) {
      // eslint-disable-next-line no-console
      console.error(`REALTIME_TEST_SERVER_ERROR malformed publish command: ${trimmed}`);
      return;
    }
    const channel = parsed.scope
      ? tenantScopeChannel(parsed.tenantId, parsed.scope)
      : tenantChannel(parsed.tenantId);
    void getRealtimeProvider()
      .publish(channel, parsed.event, parsed.payload)
      .then(() => {
        // eslint-disable-next-line no-console
        console.log("REALTIME_TEST_SERVER_PUBLISHED");
      });
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void getRealtimeProvider()
        .close()
        .finally(() => server.close(() => process.exit(0)));
    });
  }
}

void main();
