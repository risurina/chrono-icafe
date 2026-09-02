/**
 * Device realtime channel test (realtime-updates plan, Phase 3's own
 * required deliverable).
 *
 * Real HTTP server + real `ws` client + real Postgres — proves the device
 * mount's actual `resolveDeviceActor` (bearer token + fingerprint lookup
 * against `ChronoDevices`, reused verbatim from `device-auth-middleware.ts`)
 * rejects/accepts exactly like the REST device routes, and that revocation
 * closes an open socket. Mirrors `apps/agora-api/src/e2e/
 * realtime-upgrade.test.ts`'s real-server/real-client harness plus
 * `apps/chrono-api/src/modules/member/concurrency.test.ts`'s real-Postgres
 * DB bootstrap.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database). Skips
 * gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { createServer } from "node:http";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket from "ws";

function tableDdl(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    let s = `"${c.name}" ${c.getSQLType()}`;
    if (c.primary) s += " primary key";
    if (c.notNull) s += " not null";
    if (c.default !== undefined) {
      const isSqlObject =
        typeof c.default === "object" &&
        c.default !== null &&
        "queryChunks" in (c.default as Record<string, unknown>);
      if (typeof c.default === "boolean" || typeof c.default === "number") {
        s += ` default ${c.default}`;
      } else if (typeof c.default === "string") {
        s += ` default '${c.default.replace(/'/g, "''")}'`;
      } else if (typeof c.default === "object" && c.default !== null && !isSqlObject) {
        s += ` default '${JSON.stringify(c.default).replace(/'/g, "''")}'::${c.getSQLType()}`;
      } else {
        s += " default now()";
      }
    }
    return s;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

function uniqueIndexDdls(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  return cfg.indexes
    .filter((i) => i.config.unique)
    .map((i) => {
      const cols = (i.config.columns as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols});`;
    });
}

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    console.log(
      "\ndevice realtime test skipped: TEST_DATABASE_URL is not set.\n" +
        "  Set TEST_DATABASE_URL to a dedicated *test*-named database to run it.\n",
    );
    process.exit(0);
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
    die("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to drop your main DB.");
  }
  let dbName = "";
  try {
    dbName = new URL(testUrl).pathname.replace(/^\//, "");
  } catch {
    die("TEST_DATABASE_URL is not a valid connection URL.");
  }
  if (!/test/i.test(dbName) && process.env.E2E_ALLOW_DESTRUCTIVE !== "1") {
    die(`Refusing to drop tables on database "${dbName}" — its name doesn't contain "test".`);
  }

  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();
  const adminEnvUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminEnvUrl) die("DATABASE_URL_ADMIN is not set.");
  const admin = new URL(adminEnvUrl);
  const adminForTest = new URL(url.toString());
  adminForTest.username = admin.username;
  adminForTest.password = admin.password;
  process.env.DATABASE_URL_ADMIN = adminForTest.toString();
  console.log(`\ndevice realtime test mode: REAL database "${dbName}"`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";
  process.env.REALTIME_PROVIDER = "memory";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { createId } = await import("agora");
  const { eq, and } = await import("agora/db");
  const { hashApiKey } = await import("agora/server");
  const { getRealtimeProvider, connectionCount, closeConnections } = await import("agora/realtime");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoDevice } = await import("./schema");
  const { deviceRealtimeRoutes } = await import("./realtime-actor");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  dropping all tables…");
  await adminPool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_e2e') THEN
      EXECUTE 'DROP OWNED BY app_e2e CASCADE';
    END IF;
  END $$;`);
  for (const t of tables) await adminPool.query(`DROP TABLE IF EXISTS "${getTableConfig(t).name}" CASCADE;`);
  console.log("  running migration (schema push)…");
  for (const t of tables) await adminPool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await adminPool.query(ddl);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "device-realtime", name: "Device Realtime Co" });
  const branchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({ id: branchId, tenantId, name: "Branch 1", code: "B1" }),
  );

  const APPROVED_SECRET = "approved-device-secret-0123456789";
  const approvedDeviceId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoDevice).values({
      id: approvedDeviceId,
      tenantId,
      branchId,
      deviceFingerprint: "fp-approved",
      tokenHash: hashApiKey(APPROVED_SECRET),
      status: "approved",
    }),
  );

  const PENDING_SECRET = "pending-device-secret-0123456789";
  const pendingDeviceId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoDevice).values({
      id: pendingDeviceId,
      tenantId,
      branchId,
      deviceFingerprint: "fp-pending",
      tokenHash: hashApiKey(PENDING_SECRET),
      status: "pending_approval",
    }),
  );

  // One throwaway HTTP server mounting only the device realtime route.
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.route("/api/v1/device", deviceRealtimeRoutes(upgradeWebSocket));
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: (err as Error).message }, status as 401 | 403 | 429 | 500);
  });
  const server = createServer((req, res) => {
    // @ts-expect-error -- Hono's node adapter fetch handler
    app.fetch(req, res);
  });
  injectWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const wsUrl = (path: string) => `ws://127.0.0.1:${port}${path}`;

  function openSocket(opts: {
    secret: string;
    fingerprint: string;
    scope?: string;
  }): Promise<{ ws: WebSocket | null; rejectedStatus: number | null }> {
    return new Promise((resolve) => {
      const scopeQuery = opts.scope ? `?scope=${encodeURIComponent(opts.scope)}` : "";
      const socket = new WebSocket(wsUrl(`/api/v1/device/ws${scopeQuery}`), {
        headers: {
          authorization: `Bearer ${opts.secret}`,
          "x-device-fingerprint": opts.fingerprint,
        },
      });
      let settled = false;
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        resolve({ ws: socket, rejectedStatus: null });
      });
      socket.once("unexpected-response", (_req, res) => {
        if (settled) return;
        settled = true;
        resolve({ ws: null, rejectedStatus: res.statusCode ?? null });
      });
      socket.once("error", () => {
        if (settled) return;
        settled = true;
        resolve({ ws: null, rejectedStatus: null });
      });
    });
  }

  // (a) A pending_approval device's connection fails BEFORE the handshake
  // completes, with the real 403 the REST middleware would also return.
  const pendingAttempt = await openSocket({ secret: PENDING_SECRET, fingerprint: "fp-pending" });
  check(
    "pending_approval device's connection is refused before handshake (403)",
    pendingAttempt.ws === null && pendingAttempt.rejectedStatus === 403,
    `got ws=${pendingAttempt.ws !== null}, status=${pendingAttempt.rejectedStatus}`,
  );

  // Malformed/unknown credential -> 401.
  const unknownAttempt = await openSocket({ secret: "no-such-secret", fingerprint: "fp-unknown" });
  check(
    "unknown device credential is refused before handshake (401)",
    unknownAttempt.ws === null && unknownAttempt.rejectedStatus === 401,
    `got ws=${unknownAttempt.ws !== null}, status=${unknownAttempt.rejectedStatus}`,
  );

  // (b) An approved device connects, requests its own private channel, and
  // receives a session.state event published to it.
  const approvedAttempt = await openSocket({
    secret: APPROVED_SECRET,
    fingerprint: "fp-approved",
    scope: `device:${approvedDeviceId}`,
  });
  check("approved device's connection completes the handshake", approvedAttempt.ws !== null);

  if (approvedAttempt.ws) {
    const received: unknown[] = [];
    approvedAttempt.ws.on("message", (raw) => {
      received.push(JSON.parse(raw.toString()));
    });

    // Give the subscribe a tick to land, then publish to the device's own
    // channel exactly as publishSessionTransition (session/service.ts) does.
    await new Promise((r) => setTimeout(r, 100));
    const provider = getRealtimeProvider();
    await provider.publish(`tenant:${tenantId}:device:${approvedDeviceId}`, "session.state", {
      sessionId: "sess_1",
      stationId: "station_1",
      status: "active",
    });
    await new Promise((r) => setTimeout(r, 100));

    check(
      "approved device receives an event published to its own private channel",
      received.some((m) => (m as { event?: string }).event === "session.state"),
      JSON.stringify(received),
    );

    // (c) A request naming ANOTHER device's id is well-formed but never
    // granted — publishing to that (unrequested) channel must not reach us.
    await provider.publish(`tenant:${tenantId}:device:${pendingDeviceId}`, "session.state", {
      sessionId: "sess_2",
      stationId: "station_2",
      status: "active",
    });
    await new Promise((r) => setTimeout(r, 100));
    check(
      "device never receives events on another device's channel",
      received.length === 1,
      `received ${received.length} messages`,
    );

    // (d) Revoking the device closes its open socket.
    const closedPromise = new Promise<number>((resolve) => {
      approvedAttempt.ws!.once("close", (code) => resolve(code));
    });
    await withTenant(tenantId, (tx) =>
      tx.update(chronoDevice).set({ status: "revoked" }).where(and(eq(chronoDevice.id, approvedDeviceId), eq(chronoDevice.tenantId, tenantId))),
    );
    await closeConnections({ tenantId, actorKey: approvedDeviceId });
    const closeCode = await Promise.race([
      closedPromise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
    ]);
    check("revoking an open device connection closes its socket", closeCode !== -1, `closeCode=${closeCode}`);
    check("no connections remain registered for this process after revocation", connectionCount() === 0, `count=${connectionCount()}`);
  } else {
    check("approved device receives an event published to its own private channel", false, "socket never opened");
    check("device never receives events on another device's channel", false, "socket never opened");
    check("revoking an open device connection closes its socket", false, "socket never opened");
    check("no connections remain registered for this process after revocation", false, "socket never opened");
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end?.();
  await adminPool.end?.();

  console.log(`\n${passed} passed, ${failures.length} failed.\n`);
  if (failures.length > 0) {
    console.error("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
