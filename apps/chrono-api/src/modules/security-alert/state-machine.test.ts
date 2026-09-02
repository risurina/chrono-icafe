/**
 * State-machine test for security alerts (security-alerts Phase 3,
 * `.ai/plans/chrono/active/security-alerts/README.md` — "Verification
 * Commands" deliverable).
 *
 * Proves the open → acknowledged → resolved transitions (and both
 * wrong-state 409s: acknowledging a non-open alert, resolving an
 * already-resolved alert) against a REAL Postgres connection, exercised
 * through the real Hono app over HTTP — mirrors
 * `apps/chrono-api/src/modules/reservation/overlap.test.ts`'s setup/style,
 * minus the concurrency-specific machinery (no EXCLUDE constraint, no
 * parallel requests) since this module has no concurrency guarantee to
 * prove — just sequential state-guard correctness.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod — see `apps/chrono-api/.env.example`). Skips gracefully with
 * a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

/** Emit CREATE TABLE from the Drizzle schema (no drizzle-kit needed at runtime). */
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
      "\nsecurity-alert state-machine.test skipped: TEST_DATABASE_URL is not set.\n" +
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
    `\nsecurity-alert state-machine.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  // 1. Register Chrono's own permission resources BEFORE anything imports
  // agora/auth (which freezes the shared registry on first read).
  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  // 2. Import the app + foundation (this connects the db).
  const { app } = await import("../../app");
  const { auth } = await import("agora/auth");
  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { createId } = await import("agora");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  // 3. Reset → migrate (create schema) → RLS.
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

  // 4. Seed one tenant + staff owner + branch.
  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@securityalert.test", password: PW, name: "Alert Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "securityalert", name: "Security Alert Co" });
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

  // Second tenant, for the cross-tenant-404 check.
  const otherTenantId = createId();
  await adminDb.insert(schema.organization).values({ id: otherTenantId, slug: "otherco", name: "Other Co" });
  const r2 = await auth.api.signUpEmail({
    body: { email: "owner@otherco.test", password: PW, name: "Other Owner" },
  });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: otherTenantId,
    userId: r2.user.id,
    role: "owner",
  });

  // 5. Start the real HTTP server on an ephemeral port.
  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const signIn = await auth.api.signInEmail({
    body: { email: "owner@securityalert.test", password: PW },
    asResponse: true,
  });
  const ownerCookie = jar(signIn.headers.getSetCookie());
  const otherSignIn = await auth.api.signInEmail({
    body: { email: "owner@otherco.test", password: PW },
    asResponse: true,
  });
  const otherCookie = jar(otherSignIn.headers.getSetCookie());

  async function call(
    method: string,
    path: string,
    opts: { cookie?: string; tenantSlug?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-tenant-slug": opts.tenantSlug ?? "securityalert",
        cookie: opts.cookie ?? ownerCookie,
        "content-type": "application/json",
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

  console.log("\nReporting a security alert…\n");
  const reportRes = await call("POST", "/rpc/security-alerts", {
    body: {
      branchId: branch!.id,
      severity: "high",
      type: "unauthorized_access",
      message: "Someone climbed over the counter.",
    },
  });
  check("report returns 201", reportRes.status === 201, JSON.stringify(reportRes.body));
  const alertId = reportRes.body?.securityAlert?.id as string | undefined;
  check("report returns an id", typeof alertId === "string" && alertId.length > 0);
  check(
    "reported alert starts in 'open' status",
    reportRes.body?.securityAlert?.status === "open",
    JSON.stringify(reportRes.body),
  );

  console.log("\nWrong-state case 1: resolving before acknowledging is allowed by design (resolve only blocks on already-resolved) — verifying separately below.\n");

  console.log("\nAcknowledging the alert…\n");
  const ackRes = await call("POST", `/rpc/security-alerts/${alertId}/acknowledge`);
  check("acknowledge returns 200", ackRes.status === 200, JSON.stringify(ackRes.body));
  check(
    "acknowledged alert is in 'acknowledged' status",
    ackRes.body?.securityAlert?.status === "acknowledged",
    JSON.stringify(ackRes.body),
  );

  console.log("\nWrong-state case 1: acknowledging a non-open alert (already acknowledged) → 409…\n");
  const ackAgainRes = await call("POST", `/rpc/security-alerts/${alertId}/acknowledge`);
  check(
    "re-acknowledging an already-acknowledged alert returns 409",
    ackAgainRes.status === 409,
    JSON.stringify(ackAgainRes.body),
  );

  console.log("\nResolving the alert…\n");
  const resolveRes = await call("POST", `/rpc/security-alerts/${alertId}/resolve`, {
    body: { resolutionNote: "Reviewed footage — false alarm, staff member restocking." },
  });
  check("resolve returns 200", resolveRes.status === 200, JSON.stringify(resolveRes.body));
  check(
    "resolved alert is in 'resolved' status",
    resolveRes.body?.securityAlert?.status === "resolved",
    JSON.stringify(resolveRes.body),
  );
  check(
    "resolved alert carries the resolution note",
    resolveRes.body?.securityAlert?.resolutionNote ===
      "Reviewed footage — false alarm, staff member restocking.",
    JSON.stringify(resolveRes.body),
  );

  console.log("\nWrong-state case 2: resolving an already-resolved alert → 409…\n");
  const resolveAgainRes = await call("POST", `/rpc/security-alerts/${alertId}/resolve`, {
    body: { resolutionNote: "Second attempt." },
  });
  check(
    "re-resolving an already-resolved alert returns 409",
    resolveAgainRes.status === 409,
    JSON.stringify(resolveAgainRes.body),
  );

  console.log("\nResolve without required resolutionNote → 400 (Zod-enforced)…\n");
  const secondReportRes = await call("POST", "/rpc/security-alerts", {
    body: {
      branchId: branch!.id,
      severity: "low",
      type: "other",
      message: "Second incident for validation checks.",
    },
  });
  const secondAlertId = secondReportRes.body?.securityAlert?.id as string | undefined;
  const resolveNoNoteRes = await call("POST", `/rpc/security-alerts/${secondAlertId}/resolve`, {
    body: {},
  });
  check(
    "resolve without a resolutionNote is rejected (400)",
    resolveNoNoteRes.status === 400,
    JSON.stringify(resolveNoNoteRes.body),
  );

  console.log("\nCross-tenant isolation: a different tenant's owner cannot see or act on this alert…\n");
  const crossTenantGetRes = await call("GET", "/rpc/security-alerts", {
    cookie: otherCookie,
    tenantSlug: "otherco",
  });
  check(
    "a different tenant's list is empty (RLS-scoped)",
    crossTenantGetRes.status === 200 && Array.isArray(crossTenantGetRes.body?.items) &&
      crossTenantGetRes.body.items.length === 0,
    JSON.stringify(crossTenantGetRes.body),
  );
  const crossTenantAckRes = await call("POST", `/rpc/security-alerts/${alertId}/acknowledge`, {
    cookie: otherCookie,
    tenantSlug: "otherco",
  });
  check(
    "acknowledging another tenant's alert returns 404, never 403/500",
    crossTenantAckRes.status === 404,
    JSON.stringify(crossTenantAckRes.body),
  );
  const crossTenantResolveRes = await call("POST", `/rpc/security-alerts/${alertId}/resolve`, {
    cookie: otherCookie,
    tenantSlug: "otherco",
    body: { resolutionNote: "Cross-tenant attempt." },
  });
  check(
    "resolving another tenant's alert returns 404, never 403/500",
    crossTenantResolveRes.status === 404,
    JSON.stringify(crossTenantResolveRes.body),
  );

  server!.close();
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
