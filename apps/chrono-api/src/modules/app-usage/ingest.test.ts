/**
 * Device-ingest endpoint test (app-usage plan, Phase 2 "Verification
 * Commands" deliverable).
 *
 * Proves, against a REAL Postgres connection over the real Hono app:
 *  - a device with an assigned station can post launched+closed for the same
 *    runId and get exactly one row, with startedAt/endedAt matching the
 *    DEVICE-REPORTED values (not server-receive time);
 *  - replaying the identical launched payload twice produces no duplicate
 *    row (idempotent insert);
 *  - replaying the identical closed payload twice is a no-op the second time
 *    (idempotent update);
 *  - a closed event with no matching row is dropped (closedSkipped), not a 500;
 *  - a closed event whose endedAt precedes the row's startedAt is dropped
 *    (closedSkipped);
 *  - a closed event implying a duration beyond the 604,800-second cap is
 *    dropped (closedSkipped);
 *  - a device with no assigned station gets 409;
 *  - a backlog of events replayed hours after the fact records the true
 *    short duration, not the elapsed wall-clock delay.
 *
 * Mirrors `security-alert/device-report.test.ts`'s setup/style (same
 * schema-bootstrap approach, no drizzle-kit needed at runtime).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod — see `apps/chrono-api/.env.example`). Skips gracefully with
 * a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
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
      "\napp-usage ingest.test skipped: TEST_DATABASE_URL is not set.\n" +
        "  Set it to a dedicated *test*-named database to run this test.\n",
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
  console.log(
    `\napp-usage ingest.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { app } = await import("../../app");
  const { auth } = await import("agora/auth");
  const { adminDb, adminPool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoDevice } = await import("../device/schema");
  const { chronoAppUsageEvent } = await import("./schema");
  const { createId } = await import("agora");
  const { eq, and } = await import("agora/db");

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
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`,
  );
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@appusageingest.test", password: PW, name: "Ingest Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb
    .insert(schema.organization)
    .values({ id: tenantId, slug: "appusageingest", name: "App Usage Ingest Co" });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: tenantId,
    userId: ownerUserId,
    role: "owner",
  });
  const [branch] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoBranch)
      .values({ id: createId(), tenantId, name: "Main Branch", code: "MAIN" })
      .returning(),
  );

  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const signIn = await auth.api.signInEmail({
    body: { email: "owner@appusageingest.test", password: PW },
    asResponse: true,
  });
  const ownerCookie = jar(signIn.headers.getSetCookie());

  async function call(
    method: string,
    path: string,
    opts: { cookie?: string; tenantSlug?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.cookie !== undefined
          ? { "x-tenant-slug": opts.tenantSlug ?? "appusageingest", cookie: opts.cookie }
          : {}),
        "content-type": "application/json",
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  console.log("\nPairing + approving a device (with a station assigned)…\n");
  const tokenRes = await call("POST", "/rpc/devices/provisioning-tokens", {
    cookie: ownerCookie,
    body: { branchId: branch!.id, name: "Kiosk 1", pairingCodeTtlMinutes: 30, maxUses: 2 },
  });
  check("provisioning token created", tokenRes.status === 201, JSON.stringify(tokenRes.body));
  const pairingCode = tokenRes.body?.provisioningToken?.pairingCode as string;

  async function mintDevice(fingerprint: string, hostname: string) {
    const pairRes = await call("POST", "/api/v1/device/pair", { body: { pairingCode } });
    const provisioningToken = pairRes.body?.provisioningToken as string;
    const authRes = await call("POST", "/api/v1/device/auth", {
      body: { provisioningToken, fingerprint, hostname },
    });
    return authRes.body?.deviceToken as string;
  }

  const deviceToken = await mintDevice("test-fingerprint-1", "kiosk-1");
  check("device auth mints a device token", typeof deviceToken === "string" && deviceToken.length > 0);

  const listRes = await call("GET", "/rpc/devices?page=1&pageSize=10", { cookie: ownerCookie });
  const deviceId = listRes.body?.items?.[0]?.id as string;

  const approveRes = await call("POST", `/rpc/devices/${deviceId}/approve`, {
    cookie: ownerCookie,
    body: { newStationName: "Station 1", newStationNumber: "PC-01" },
  });
  check("device approved with a station", approveRes.status === 200, JSON.stringify(approveRes.body));

  const authHeaders = { authorization: `Bearer ${deviceToken}`, "x-device-fingerprint": "test-fingerprint-1" };

  console.log("\nApproved device with NO assigned station -> 409…\n");
  {
    const unassignedToken = await mintDevice("test-fingerprint-unassigned", "kiosk-unassigned");
    const listRes2 = await call("GET", "/rpc/devices?page=1&pageSize=10", { cookie: ownerCookie });
    const unassignedDeviceId = (listRes2.body?.items ?? []).find(
      (d: { hostname?: string }) => d.hostname === "kiosk-unassigned",
    )?.id as string;
    const approveRes2 = await call("POST", `/rpc/devices/${unassignedDeviceId}/approve`, {
      cookie: ownerCookie,
      body: { newStationName: "Station 2", newStationNumber: "PC-02" },
    });
    check("second device approved", approveRes2.status === 200, JSON.stringify(approveRes2.body));
    // Approve always assigns a station (the module has no "approve with no
    // station" path) — directly null it out to exercise the 409 case, the
    // same state a station deletion (onDelete: "set null") would leave behind.
    await withTenant(tenantId, (tx) =>
      tx.update(chronoDevice).set({ stationId: null }).where(eq(chronoDevice.id, unassignedDeviceId)),
    );

    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [] },
      headers: { authorization: `Bearer ${unassignedToken}`, "x-device-fingerprint": "test-fingerprint-unassigned" },
    });
    check("device with no station -> 409", res.status === 409, JSON.stringify(res.body));
  }

  console.log("\nHappy path: launched then closed for the same runId…\n");
  const now = new Date();
  const startedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
  const endedAt = now.toISOString();
  const runId1 = "run-1";
  {
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: {
        launched: [{ runId: runId1, category: "app", appName: "notepad.exe", startedAt }],
        closed: [],
      },
      headers: authHeaders,
    });
    check(
      "launched accepted",
      res.status === 201 && res.body.launchedAccepted === 1,
      JSON.stringify(res.body),
    );
  }
  {
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: runId1, endedAt }] },
      headers: authHeaders,
    });
    check(
      "closed applied",
      res.status === 201 && res.body.closedApplied === 1 && res.body.closedSkipped === 0,
      JSON.stringify(res.body),
    );
  }

  const [row1] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoAppUsageEvent)
      .where(and(eq(chronoAppUsageEvent.deviceId, deviceId), eq(chronoAppUsageEvent.runId, runId1)))
      .limit(1),
  );
  check("exactly one row for the run", !!row1);
  check(
    "startedAt/endedAt match the DEVICE-REPORTED values, not server-receive time",
    row1?.startedAt.toISOString() === startedAt && row1?.endedAt?.toISOString() === endedAt,
    JSON.stringify({ got: { startedAt: row1?.startedAt, endedAt: row1?.endedAt }, want: { startedAt, endedAt } }),
  );
  check("closedReason is device_closed", row1?.closedReason === "device_closed");
  check(
    "durationSeconds matches the device-reported gap (~60s)",
    row1?.durationSeconds === 60,
    String(row1?.durationSeconds),
  );

  console.log("\nReplaying the identical launched payload twice -> no duplicate…\n");
  {
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: {
        launched: [{ runId: runId1, category: "app", appName: "notepad.exe", startedAt }],
        closed: [],
      },
      headers: authHeaders,
    });
    check(
      "replayed launched is a no-op (0 accepted)",
      res.status === 201 && res.body.launchedAccepted === 0,
      JSON.stringify(res.body),
    );
  }
  const dupRows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoAppUsageEvent)
      .where(and(eq(chronoAppUsageEvent.deviceId, deviceId), eq(chronoAppUsageEvent.runId, runId1))),
  );
  check("still exactly one row after replaying launched", dupRows.length === 1, String(dupRows.length));

  console.log("\nReplaying the identical closed payload twice -> no-op the second time…\n");
  {
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: runId1, endedAt }] },
      headers: authHeaders,
    });
    check(
      "replayed closed is a no-op (not re-applied, not skipped)",
      res.status === 201 && res.body.closedApplied === 0 && res.body.closedSkipped === 0,
      JSON.stringify(res.body),
    );
  }

  console.log("\nA closed event with no matching launched row -> closedSkipped, not a 500…\n");
  {
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: "run-never-launched", endedAt }] },
      headers: authHeaders,
    });
    check(
      "unmatched closed -> closedSkipped, 201 not 500",
      res.status === 201 && res.body.closedSkipped === 1 && res.body.closedApplied === 0,
      JSON.stringify(res.body),
    );
  }

  console.log("\nA closed event whose endedAt precedes startedAt -> closedSkipped…\n");
  {
    const runId2 = "run-2-bad-order";
    const badStartedAt = new Date(now.getTime() + 60_000).toISOString(); // future
    await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [{ runId: runId2, category: "app", appName: "bad.exe", startedAt: badStartedAt }], closed: [] },
      headers: authHeaders,
    });
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: runId2, endedAt: now.toISOString() }] }, // before startedAt
      headers: authHeaders,
    });
    check(
      "endedAt < startedAt -> closedSkipped, never applied",
      res.status === 201 && res.body.closedSkipped === 1 && res.body.closedApplied === 0,
      JSON.stringify(res.body),
    );
    const [row2] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(chronoAppUsageEvent)
        .where(and(eq(chronoAppUsageEvent.deviceId, deviceId), eq(chronoAppUsageEvent.runId, runId2)))
        .limit(1),
    );
    check("rejected row stays open (endedAt still null)", row2?.endedAt === null);
  }

  console.log("\nA closed event implying a duration beyond the 604,800s cap -> closedSkipped…\n");
  {
    const runId3 = "run-3-too-long";
    const longAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [{ runId: runId3, category: "app", appName: "long.exe", startedAt: longAgo }], closed: [] },
      headers: authHeaders,
    });
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: runId3, endedAt: now.toISOString() }] },
      headers: authHeaders,
    });
    check(
      "duration beyond 7-day cap -> closedSkipped",
      res.status === 201 && res.body.closedSkipped === 1 && res.body.closedApplied === 0,
      JSON.stringify(res.body),
    );
  }

  console.log("\nBacklog replay: a run replayed hours late records the TRUE short duration…\n");
  {
    const runId4 = "run-4-backlog";
    // The device was offline for hours; both events are replayed together,
    // long after the fact — but startedAt/endedAt are the device's own
    // domain timestamps, only 45 seconds apart.
    const backlogStartedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const backlogEndedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000 + 45_000).toISOString(); // +45s
    await call("POST", "/api/v1/device/app-usage/events", {
      body: {
        launched: [{ runId: runId4, category: "game", appName: "game.exe", startedAt: backlogStartedAt }],
        closed: [],
      },
      headers: authHeaders,
    });
    const res = await call("POST", "/api/v1/device/app-usage/events", {
      body: { launched: [], closed: [{ runId: runId4, endedAt: backlogEndedAt }] },
      headers: authHeaders,
    });
    check("backlog closed applied", res.status === 201 && res.body.closedApplied === 1, JSON.stringify(res.body));
    const [row4] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(chronoAppUsageEvent)
        .where(and(eq(chronoAppUsageEvent.deviceId, deviceId), eq(chronoAppUsageEvent.runId, runId4)))
        .limit(1),
    );
    check(
      "duration is the TRUE short run length (~45s), not the ~3h offline delay",
      row4?.durationSeconds === 45,
      String(row4?.durationSeconds),
    );
  }

  server!.close();
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
