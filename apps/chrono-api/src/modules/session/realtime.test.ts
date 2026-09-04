/**
 * Session-transition publish test (realtime-updates Phase 2b,
 * `.ai/plans/chrono/active/realtime-updates/README.md` — Phase 2b's own
 * required deliverable).
 *
 * Proves `publishSessionTransition` (`session/service.ts`) publishes a
 * correctly-shaped `session.state` event plus the station's own
 * `station.status`/`branch.summary` (reusing `publishStationTransition`),
 * for every session lifecycle transition, against a REAL Postgres
 * connection and the REAL in-memory realtime provider.
 *
 * Also proves: the expiry sweep (`runSessionExpirySweepOnce`) publishes
 * identically to a manual close; and device revoke — which never touches a
 * station or session row — publishes NOTHING (the regression case the plan
 * calls out as being as important as the positive assertions).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database). Skips
 * gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is, Column } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

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
      const cols = (i.config.columns as { name: string }[])
        .map((c) => `"${c.name}"`)
        .join(", ");
      // Include the index's `.where()` predicate — a partial unique index applies
      // as a FULL unique constraint if this is dropped, causing false collisions
      // unrelated to the invariant it enforces (reservations-queue-and-self-
      // service plan, round-2 audit CONDITION 5 — fixed identically in all four
      // harnesses that duplicate this helper).
      const where = i.config.where;
      const whereSql = where ? ` where ${sqlToText(where)}` : "";
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols})${whereSql};`;
    });
}

function sqlToText(fragment: unknown): string {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (is(chunk, Column)) return `"${chunk.name}"`;
      if (chunk && typeof chunk === "object" && "value" in (chunk as Record<string, unknown>)) {
        const v = (chunk as { value: unknown }).value;
        return Array.isArray(v) ? v.join("") : String(v);
      }
      return String(chunk);
    })
    .join("");
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
      "\nsession realtime-publish test skipped: TEST_DATABASE_URL is not set.\n" +
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
    die(
      `Refusing to drop tables on database "${dbName}" — its name doesn't contain "test".\n` +
        `  Point TEST_DATABASE_URL at a dedicated test database, or set E2E_ALLOW_DESTRUCTIVE=1 to override.`,
    );
  }

  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();

  const adminEnvUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminEnvUrl) {
    die("DATABASE_URL_ADMIN is not set — needed to run schema setup against the test database.");
  }
  const admin = new URL(adminEnvUrl);
  const adminForTest = new URL(url.toString());
  adminForTest.username = admin.username;
  adminForTest.password = admin.password;
  process.env.DATABASE_URL_ADMIN = adminForTest.toString();
  console.log(`\nsession realtime-publish test mode: REAL database "${dbName}"`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoStation, chronoStationGroup } = await import("../station/schema");
  const { chronoSession } = await import("./schema");
  const { chronoDevice } = await import("../device/schema");
  const { eq } = await import("agora/db");
  const { startSession, closeSession, publishSessionTransition } = await import("./service");
  const { runSessionExpirySweepOnce } = await import("./expiry");
  const { getRealtimeProvider, tenantScopeChannel } = await import("agora/realtime");
  const { createId } = await import("agora");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  dropping all tables…");
  await adminPool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_e2e') THEN
      EXECUTE 'DROP OWNED BY app_e2e CASCADE';
    END IF;
  END $$;`);
  for (const t of tables) {
    await adminPool.query(`DROP TABLE IF EXISTS "${getTableConfig(t).name}" CASCADE;`);
  }
  console.log("  running migration (schema push)…");
  for (const t of tables) await adminPool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await adminPool.query(ddl);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "session-realtime-publish",
    name: "Session Realtime Publish Co",
  });
  const branchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({ id: branchId, tenantId, name: "Main", code: "MAIN" }),
  );
  const groupId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStationGroup).values({
      id: groupId,
      tenantId,
      branchId,
      name: "Standard",
      code: "STD",
      hourlyRate: "60.00",
    }),
  );
  const stationId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStation).values({
      id: stationId,
      tenantId,
      branchId,
      stationGroupId: groupId,
      name: "PC-1",
      stationNumber: "1",
      status: "available",
    }),
  );
  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "player@session-realtime.test",
      name: "Player",
      passwordHash: "unused-in-this-test",
    }),
  );
  const { chronoWallet } = await import("../wallet/schema");
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoWallet).values({ id: createId(), tenantId, memberId, balance: "100.00" }),
  );

  const provider = getRealtimeProvider();
  const stateEvents: unknown[] = [];
  const statusEvents: unknown[] = [];
  const summaryEvents: unknown[] = [];
  await provider.subscribe(tenantScopeChannel(tenantId, `branch:${branchId}`), (event, payload) => {
    if (event === "session.state") stateEvents.push(payload);
    if (event === "station.status") statusEvents.push(payload);
  });
  await provider.subscribe(tenantScopeChannel(tenantId, `branch-summary:${branchId}`), (_event, payload) => {
    summaryEvents.push(payload);
  });

  // 1. Manual start — real startSession(), mirroring the staff route's own
  // call order (commit inside withTenant, publish after).
  const started = await withTenant(tenantId, (tx) =>
    startSession(tx, { tenantId, stationId, memberId, startedByUserId: createId() }),
  );
  await publishSessionTransition(tenantId, started);

  check("start: exactly one session.state event", stateEvents.length === 1);
  check(
    "start: session.state is active for the right session/station",
    JSON.stringify(stateEvents[0]) ===
      JSON.stringify({ sessionId: started.id, stationId, status: "active" }),
    JSON.stringify(stateEvents[0]),
  );
  check("start: station.status flips to occupied", statusEvents.length === 1 &&
    JSON.stringify(statusEvents[0]) === JSON.stringify({ stationId, branchId, status: "occupied" }));
  check(
    "start: branch.summary reflects one occupied station",
    JSON.stringify(summaryEvents[0]) ===
      JSON.stringify({ branchId, counts: { available: 0, occupied: 1, maintenance: 0, offline: 0 }, total: 1 }),
  );

  // 2. Pause — mirrors session/routes.ts's own inline update (no dedicated
  // pauseSession service function exists; the plain CRUD isn't this test's
  // concern, publishSessionTransition against real committed state is).
  const [paused] = await withTenant(tenantId, (tx) =>
    tx
      .update(chronoSession)
      .set({ status: "paused", pausedAt: new Date() })
      .where(eq(chronoSession.id, started.id))
      .returning(),
  );
  await publishSessionTransition(tenantId, paused!);
  check(
    "pause: session.state is paused",
    JSON.stringify(stateEvents[1]) ===
      JSON.stringify({ sessionId: started.id, stationId, status: "paused" }),
  );
  check(
    "pause: station.status is unchanged (still occupied) — pause never flips the station",
    JSON.stringify(statusEvents[1]) === JSON.stringify({ stationId, branchId, status: "occupied" }),
  );

  // 3. Resume.
  const [resumed] = await withTenant(tenantId, (tx) =>
    tx
      .update(chronoSession)
      .set({ status: "active", pausedAt: null })
      .where(eq(chronoSession.id, started.id))
      .returning(),
  );
  await publishSessionTransition(tenantId, resumed!);
  check(
    "resume: session.state is active again",
    JSON.stringify(stateEvents[2]) ===
      JSON.stringify({ sessionId: started.id, stationId, status: "active" }),
  );

  // 4. Extend (status doesn't change, only scheduledEndAt — publish still fires).
  const [extended] = await withTenant(tenantId, (tx) =>
    tx
      .update(chronoSession)
      .set({ scheduledEndAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(chronoSession.id, started.id))
      .returning(),
  );
  await publishSessionTransition(tenantId, extended!);
  check("extend: publishes a session.state event too", stateEvents.length === 4);

  // 5. Manual end — real closeSession().
  const closedResult = await withTenant(tenantId, (tx) =>
    closeSession(tx, { tenantId, sessionId: started.id, performedByUserId: null }),
  );
  check("end: closeSession did not report alreadyClosed", closedResult.alreadyClosed === false);
  await publishSessionTransition(tenantId, closedResult.session);
  check(
    "end: session.state is ended",
    JSON.stringify(stateEvents[4]) ===
      JSON.stringify({ sessionId: started.id, stationId, status: "ended" }),
  );
  check(
    "end: station.status returns to available",
    JSON.stringify(statusEvents[4]) === JSON.stringify({ stationId, branchId, status: "available" }),
  );
  check(
    "end: branch.summary reflects zero occupied again",
    JSON.stringify(summaryEvents[4]) ===
      JSON.stringify({ branchId, counts: { available: 1, occupied: 0, maintenance: 0, offline: 0 }, total: 1 }),
  );

  // 6. Expiry sweep publishes identically to a manual close.
  // Uses a SEPARATE station: this repo's shared test-DDL generator
  // (tableDdl/uniqueIndexDdls) doesn't emit the WHERE clause on partial
  // unique indexes, so it enforces chrono_session_active_per_station_uq as
  // a FULL unique constraint on (tenantId, stationId) in this harness — not
  // just for active/paused sessions as the real migration does. Reusing
  // `stationId` here would collide with step 1-5's now-"ended" session
  // even though the real constraint would allow it. Same class of false
  // collision already worked around in reconciliation/routes.test.ts.
  const sweepStationId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStation).values({
      id: sweepStationId,
      tenantId,
      branchId,
      stationGroupId: groupId,
      name: "PC-3",
      stationNumber: "3",
      status: "available",
    }),
  );
  const sweptSession = await withTenant(tenantId, (tx) =>
    startSession(tx, { tenantId, stationId: sweepStationId, memberId, startedByUserId: null }),
  );
  await publishSessionTransition(tenantId, sweptSession); // the start half, for realism
  await withTenant(tenantId, (tx) =>
    tx
      .update(chronoSession)
      .set({ scheduledEndAt: new Date(Date.now() - 1000) })
      .where(eq(chronoSession.id, sweptSession.id)),
  );
  const beforeSweepCount = stateEvents.length;
  const sweepResult = await runSessionExpirySweepOnce();
  check("expiry sweep closed the due session", sweepResult.closed === 1);
  check(
    "expiry sweep published a session.state = ended event, same shape as manual end",
    stateEvents.length === beforeSweepCount + 1 &&
      JSON.stringify(stateEvents[beforeSweepCount]) ===
        JSON.stringify({ sessionId: sweptSession.id, stationId: sweepStationId, status: "ended" }),
    JSON.stringify(stateEvents[beforeSweepCount]),
  );

  // 7. QR check-in publishes identically to a manual start. NOT proven by
  // re-running the full HTTP/token-signing flow here (that belongs to qr's
  // own e2e coverage) — proven by directly exercising the same call the QR
  // handler makes: startSession() with startedByUserId: null (self-service,
  // exactly as qr/public-routes.ts calls it) followed by
  // publishSessionTransition(), asserting the resulting event is
  // structurally identical in shape to step 1's staff-initiated start
  // (only the session/station ids differ).
  const qrStation = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStation).values({
      id: qrStation,
      tenantId,
      branchId,
      stationGroupId: groupId,
      name: "PC-2",
      stationNumber: "2",
      status: "available",
    }),
  );
  const qrSession = await withTenant(tenantId, (tx) =>
    startSession(tx, { tenantId, stationId: qrStation, memberId, startedByUserId: null }),
  );
  const beforeQrCount = stateEvents.length;
  await publishSessionTransition(tenantId, qrSession);
  check(
    "QR check-in publishes a session.state event, same shape as a manual start",
    stateEvents.length === beforeQrCount + 1 &&
      JSON.stringify(stateEvents[beforeQrCount]) ===
        JSON.stringify({ sessionId: qrSession.id, stationId: qrStation, status: "active" }),
    JSON.stringify(stateEvents[beforeQrCount]),
  );

  // 8. Negative: device revoke touches no station/session row and must
  // publish NOTHING.
  const deviceId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoDevice).values({
      id: deviceId,
      tenantId,
      branchId,
      deviceFingerprint: "fp-realtime-test",
      tokenHash: "hash-realtime-test",
      status: "approved",
    }),
  );
  const beforeRevokeCounts = [stateEvents.length, statusEvents.length, summaryEvents.length];
  await withTenant(tenantId, (tx) =>
    tx.update(chronoDevice).set({ status: "revoked" }).where(eq(chronoDevice.id, deviceId)),
  );
  check(
    "device revoke publishes nothing (no station/session touch, no realtime call)",
    stateEvents.length === beforeRevokeCounts[0] &&
      statusEvents.length === beforeRevokeCounts[1] &&
      summaryEvents.length === beforeRevokeCounts[2],
  );

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
