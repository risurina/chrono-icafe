/**
 * Concurrency test for `applyPointsDelta`'s redemption race guard (loyalty
 * Phase 3, `.ai/plans/chrono/active/loyalty/README.md` — "diverges from
 * oikos" #2 / the Phase 3 deliverable).
 *
 * Proves the `SELECT ... FOR UPDATE`-then-write discipline in
 * `service.ts#applyPointsDelta` actually serializes concurrent redemptions
 * under REAL concurrent Postgres connections — not just that it typechecks.
 * PGlite cannot exercise this: it is a single in-process connection, so it
 * can never reproduce genuine concurrent-connection row-lock contention
 * (the same limitation `reservation/overlap.test.ts` and `wallet`'s own
 * concurrency test note).
 *
 * Standalone tsx script (no unit-test runner in this repo) — mirrors
 * `reservation/overlap.test.ts`'s structure exactly: seeds one tenant/
 * member/loyalty account via the real Hono app + a REAL Postgres connection,
 * starts the real HTTP server, fires N concurrent `POST
 * /rpc/loyalty/accounts/:memberId/redeem` requests each redeeming the
 * account's ENTIRE balance, and asserts exactly one 200 + N-1 409s,
 * confirmed by a direct DB query afterward.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod — see `apps/chrono-api/.env.example`). Skips gracefully with a
 * clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const N = 10;
const STARTING_BALANCE = 100;
const REDEEM_POINTS = 100; // exactly the full balance — only one redemption can succeed

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
      "\nloyalty/service.test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the loyalty redemption race guard under REAL\n" +
        "  concurrent Postgres connections (PGlite cannot exercise genuine\n" +
        "  concurrent-connection row locking). Set TEST_DATABASE_URL to a\n" +
        "  dedicated *test*-named database to run it.\n",
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

  // A direct (non-pooled) connection, and NO cap on pool size — genuine
  // concurrent connections racing the row lock is the entire point of this
  // test; a DB_POOL_MAX=1 pool would serialize the requests itself.
  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();

  // TEST_DATABASE_URL's credential (chrono_app) is the real NOBYPASSRLS,
  // DML-only app role — it cannot CREATE tables/indexes. Reuse
  // DATABASE_URL_ADMIN's credentials but point them at the TEST
  // database/host so migration runs against chrono_test, never the dev DB.
  const adminEnvUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminEnvUrl) {
    die("DATABASE_URL_ADMIN is not set — needed to run schema setup against the test database.");
  }
  const admin = new URL(adminEnvUrl);
  const adminForTest = new URL(url.toString());
  adminForTest.username = admin.username;
  adminForTest.password = admin.password;
  process.env.DATABASE_URL_ADMIN = adminForTest.toString();
  console.log(`\nloyalty/service.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  // Common app env — mirrors overlap.test.ts's minimal boot set.
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
  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES, eq } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoLoyaltyAccount } = await import("./schema");
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

  // 4. Seed one tenant + staff owner + a tenant member with a loyalty
  // account holding exactly enough points for ONE redemption.
  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@loyaltyrace.test", password: PW, name: "Loyalty Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "loyaltyrace", name: "Loyalty Race Co" });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: tenantId,
    userId: ownerUserId,
    role: "owner",
  });
  const [customer] = await withTenant(tenantId, (tx) =>
    tx
      .insert(schema.tenantMember)
      .values({
        id: createId(),
        tenantId,
        email: "customer@loyaltyrace.test",
        name: "Race Customer",
        passwordHash: "unused",
      })
      .returning(),
  );
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoLoyaltyAccount).values({
      id: createId(),
      tenantId,
      memberId: customer!.id,
      pointsBalance: STARTING_BALANCE,
      lifetimePoints: STARTING_BALANCE,
      tier: "bronze",
    }),
  );

  // 5. Start the real HTTP server on an ephemeral port.
  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const r2 = await auth.api.signInEmail({
    body: { email: "owner@loyaltyrace.test", password: PW },
    asResponse: true,
  });
  const ownerCookie = jar(r2.headers.getSetCookie());

  async function redeem(): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}/rpc/loyalty/accounts/${customer!.id}/redeem`, {
      method: "POST",
      headers: {
        "x-tenant-slug": "loyaltyrace",
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ points: REDEEM_POINTS, reason: "Race redemption" }),
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

  console.log(`\nFiring ${N} concurrent POST /rpc/loyalty/accounts/:memberId/redeem for the identical account…\n`);
  const results = await Promise.all(Array.from({ length: N }, () => redeem()));
  const okCount = results.filter((r) => r.status === 200).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  const other = results.filter((r) => r.status !== 200 && r.status !== 409);

  check(
    `exactly one 200 among ${N} concurrent redemptions of the full balance`,
    okCount === 1,
    `got ${okCount} × 200, statuses: ${results.map((r) => r.status).join(",")}`,
  );
  check(
    `exactly ${N - 1} × 409 among the rest`,
    conflictCount === N - 1,
    `got ${conflictCount} × 409`,
  );
  check("no unexpected status codes", other.length === 0, JSON.stringify(other));

  // 6. Confirm at the DB level: exactly one redemption's worth was deducted.
  const dbAccount = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoLoyaltyAccount)
      .where(eq(chronoLoyaltyAccount.memberId, customer!.id)),
  );
  const finalBalance = dbAccount[0]?.pointsBalance;
  check(
    "final balance matches exactly one redemption's worth (0)",
    finalBalance === STARTING_BALANCE - REDEEM_POINTS,
    `got balance ${finalBalance}`,
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
