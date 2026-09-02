/**
 * Device-reporting endpoint test (security-alerts Phase 5,
 * `.ai/plans/chrono/active/security-alerts/README.md` — "Verification
 * Commands" deliverable).
 *
 * Proves, against a REAL Postgres connection over the real Hono app:
 *  - an approved device can raise an alert via POST /api/v1/device/security-alert,
 *    and the row lands with raisedBy: "device" + the device's own
 *    branchId/stationId/deviceId (never client-supplied);
 *  - a device with no bearer credentials, and one with an unknown/invalid
 *    token, are both rejected (401);
 *  - the per-device rate limit trips after its threshold.
 *
 * Mirrors `state-machine.test.ts`'s setup/style (same schema-bootstrap
 * approach, no drizzle-kit needed at runtime).
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
      "\nsecurity-alert device-report.test skipped: TEST_DATABASE_URL is not set.\n" +
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
    `\nsecurity-alert device-report.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
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
  const { chronoSecurityAlert } = await import("./schema");
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
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`,
  );
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@devicereport.test", password: PW, name: "Report Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb
    .insert(schema.organization)
    .values({ id: tenantId, slug: "devicereport", name: "Device Report Co" });
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
    body: { email: "owner@devicereport.test", password: PW },
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
          ? { "x-tenant-slug": opts.tenantSlug ?? "devicereport", cookie: opts.cookie }
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

  console.log("\nPairing + approving a device…\n");
  const tokenRes = await call("POST", "/rpc/devices/provisioning-tokens", {
    cookie: ownerCookie,
    body: { branchId: branch!.id, name: "Kiosk 1", pairingCodeTtlMinutes: 30, maxUses: 1 },
  });
  check("provisioning token created", tokenRes.status === 201, JSON.stringify(tokenRes.body));
  const pairingCode = tokenRes.body?.provisioningToken?.pairingCode as string;

  const pairRes = await call("POST", "/api/v1/device/pair", { body: { pairingCode } });
  check("pair succeeds", pairRes.status === 200, JSON.stringify(pairRes.body));
  const provisioningToken = pairRes.body?.provisioningToken as string;

  const fingerprint = "test-fingerprint-1";
  const authRes = await call("POST", "/api/v1/device/auth", {
    body: { provisioningToken, fingerprint, hostname: "kiosk-1" },
  });
  check("device auth mints a device token", authRes.status === 201, JSON.stringify(authRes.body));
  const deviceToken = authRes.body?.deviceToken as string;

  const listRes = await call("GET", "/rpc/devices?page=1&pageSize=10", { cookie: ownerCookie });
  const deviceId = listRes.body?.items?.[0]?.id as string;
  check("device row exists after auth", typeof deviceId === "string" && deviceId.length > 0);

  const approveRes = await call("POST", `/rpc/devices/${deviceId}/approve`, {
    cookie: ownerCookie,
    body: { newStationName: "Station 1", newStationNumber: "PC-01" },
  });
  check("device approved", approveRes.status === 200, JSON.stringify(approveRes.body));
  const stationId = approveRes.body?.device?.stationId as string;

  console.log("\nUnauthenticated / invalid credential rejection…\n");
  const noAuthRes = await call("POST", "/api/v1/device/security-alert", {
    body: { severity: "high", type: "chassis_open", message: "Case opened." },
  });
  check("missing credentials -> 401", noAuthRes.status === 401, JSON.stringify(noAuthRes.body));

  const badAuthRes = await call("POST", "/api/v1/device/security-alert", {
    body: { severity: "high", type: "chassis_open", message: "Case opened." },
    headers: { authorization: "Bearer not-a-real-token", "x-device-fingerprint": fingerprint },
  });
  check("invalid token -> 401", badAuthRes.status === 401, JSON.stringify(badAuthRes.body));

  console.log("\nValid device raises an alert…\n");
  const reportRes = await call("POST", "/api/v1/device/security-alert", {
    body: { severity: "critical", type: "chassis_open", message: "Chassis intrusion detected." },
    headers: { authorization: `Bearer ${deviceToken}`, "x-device-fingerprint": fingerprint },
  });
  check("device report -> 201", reportRes.status === 201, JSON.stringify(reportRes.body));
  const alertId = reportRes.body?.id as string | undefined;
  check("report returns an id", typeof alertId === "string" && alertId.length > 0);

  const { eq } = await import("agora/db");
  const [alertRow] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoSecurityAlert).where(eq(chronoSecurityAlert.id, alertId!)).limit(1),
  );
  check("alert.raisedBy === 'device'", alertRow?.raisedBy === "device");
  check("alert.deviceId matches the reporting device", alertRow?.deviceId === deviceId);
  check(
    "alert.branchId/stationId derived from the device row, not client input",
    alertRow?.branchId === branch!.id && alertRow?.stationId === stationId,
  );

  console.log("\nRate limit…\n");
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await call("POST", "/api/v1/device/security-alert", {
      body: { severity: "low", type: "other", message: `spam ${i}` },
      headers: { authorization: `Bearer ${deviceToken}`, "x-device-fingerprint": fingerprint },
    });
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  check("rate limit trips within 12 requests (threshold is 10/hour)", limited);

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
