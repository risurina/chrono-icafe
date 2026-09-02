/**
 * Promo redemption concurrency test (promos Phase 3, `.ai/plans/chrono/
 * active/promos/README.md` — Phase 3's own required deliverable).
 *
 * Proves `lockAndValidatePromo`'s `SELECT ... FOR UPDATE` row lock +
 * COUNT-inside-transaction against `ChronoPromoRedemptions` actually
 * serializes concurrent redemption of the same `maxRedemptions`-capped
 * promo under REAL concurrent Postgres connections — not just that it
 * typechecks. PGlite cannot exercise this: it is a single in-process
 * connection, so it can never reproduce genuine concurrent-connection row-
 * lock contention (same limitation noted by reservation's/wallet's/credit's/
 * voucher's own concurrency tests).
 *
 * Standalone tsx script (no unit-test runner in this repo) — mirrors
 * voucher/service.test.ts's scaffold exactly: resets and re-migrates a
 * dedicated *test*-named database, seeds one tenant + one active promo
 * (`maxRedemptions: 1`), fires N concurrent `redeemPromo` calls (each
 * preceded by its own `lockAndValidatePromo` call, in its own `withTenant`
 * transaction/connection, against distinct synthetic sale ids) for the
 * identical code, and asserts exactly ONE succeeds and N-1 throw a
 * "reached its redemption limit" error — confirmed by a direct DB query
 * afterward.
 *
 * `lockAndValidatePromo`/`redeemPromo` are called directly against
 * `service.ts` — they do not need the checkout route to exist (pos's own
 * checkout route lands in Phase 4).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const N = 10;

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
      "\npromo redemption concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the promo maxRedemptions row-lock guard under REAL\n" +
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

  // A direct (non-pooled) connection, and NO cap on pool size — this test's
  // entire point is genuine concurrent connections racing the row lock; a
  // DB_POOL_MAX=1 pool would serialize the calls itself and prove nothing.
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
    `\npromo redemption concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
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

  // 2. Import the foundation (this connects the db).
  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoPromo, chronoPromoRedemption } = await import("./schema");
  const { lockAndValidatePromo, redeemPromo, computeDiscount } = await import("./service");
  const { createId } = await import("agora");
  const { eq, and } = await import("agora/db");

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

  // 4. Seed one tenant + one active promo capped at maxRedemptions: 1.
  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "promo-concurrency",
    name: "Promo Concurrency Co",
  });
  const code = "RACEPROMO";
  const promoId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoPromo).values({
      id: promoId,
      tenantId,
      name: "Race Condition Special",
      code,
      status: "active",
      discountType: "fixed_amount",
      discountValue: "50.00",
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      maxRedemptions: 1,
      maxRedemptionsPerMember: null,
    }),
  );

  console.log(`\nFiring ${N} concurrent redemption attempts for the identical maxRedemptions:1 promo…\n`);
  const attempt = async (i: number) => {
    return withTenant(tenantId, async (tx) => {
      const promo = await lockAndValidatePromo(tx, {
        tenantId,
        code,
        branchId: "any-branch",
        subtotal: "100.00",
      });
      if (!promo) {
        throw new Error("promo did not resolve");
      }
      const discountAmount = computeDiscount("fixed_amount", promo.discountValue, "100.00");
      await redeemPromo(tx, {
        tenantId,
        promoId: promo.id,
        saleId: `synthetic-sale-${i}-${createId()}`,
        discountAmount,
      });
      return { discountAmount };
    });
  };
  const calls = Array.from({ length: N }, (_, i) => attempt(i));
  const results = await Promise.allSettled(calls);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );

  check(
    `exactly one success among ${N} concurrent identical-promo redemptions`,
    fulfilled.length === 1,
    `got ${fulfilled.length}, statuses: ${results.map((r) => r.status).join(",")}`,
  );
  check(
    `exactly ${N - 1} rejections among the rest`,
    rejected.length === N - 1,
    `got ${rejected.length}`,
  );
  const allRejectionsAreCapReached = rejected.every((r) =>
    /reached its redemption limit/i.test(r.reason?.message ?? String(r.reason)),
  );
  check(
    "every rejection is the expected 'reached its redemption limit' error",
    allRejectionsAreCapReached,
    JSON.stringify(rejected.map((r) => r.reason?.message ?? String(r.reason))),
  );

  // 5. Confirm at the DB level: exactly one ChronoPromoRedemptions row exists
  // for this promo.
  const dbRows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoPromoRedemption)
      .where(and(eq(chronoPromoRedemption.tenantId, tenantId), eq(chronoPromoRedemption.promoId, promoId))),
  );
  check(
    "exactly one ChronoPromoRedemptions row exists for this promo",
    dbRows.length === 1,
    `got ${dbRows.length}`,
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
