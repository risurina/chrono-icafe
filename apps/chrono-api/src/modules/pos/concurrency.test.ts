/**
 * POS stock concurrency test (pos Phase 3, `.ai/plans/chrono/active/pos/
 * README.md` — Phase 3's own required deliverable).
 *
 * Proves `lockAndValidateProducts`'s `SELECT ... FOR UPDATE` row lock
 * actually serializes concurrent single-unit checkouts against the same
 * trackStock product under REAL concurrent Postgres connections — not just
 * that it typechecks. PGlite cannot exercise this (same limitation noted by
 * `reservations`' overlap.test.ts and `wallet`'s concurrency.test.ts before
 * it).
 *
 * Standalone tsx script — mirrors wallet/concurrency.test.ts's scaffold:
 * resets and re-migrates a dedicated *test*-named database, seeds one
 * tenant + branch + one trackStock product with stockQuantity: N, fires N
 * concurrent single-unit checkouts over REAL separate Postgres connections,
 * and asserts: (a) exactly N sales complete with zero errors from those N
 * legitimate attempts; (b) final stockQuantity === 0, never negative; (c) an
 * (N+1)th checkout after that fails with 409 insufficient stock.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const N = 10;

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
      "\npos concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the POS stock row-lock guard under REAL concurrent\n" +
        "  Postgres connections (PGlite cannot exercise genuine concurrent-\n" +
        "  connection row locking). Set TEST_DATABASE_URL to a dedicated\n" +
        "  *test*-named database to run it.\n",
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
  console.log(`\npos concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { auth } = await import("agora/auth");
  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoProduct } = await import("./schema");
  const { checkout } = await import("./service");
  const { createId } = await import("agora");
  const { eq } = await import("agora/db");

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
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@pos-concurrency.test", password: PW, name: "POS Owner" },
  });
  const cashierUserId = r.user.id;
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "pos-concurrency",
    name: "POS Concurrency Co",
  });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: tenantId,
    userId: cashierUserId,
    role: "owner",
  });
  const [branch] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoBranch)
      .values({ id: createId(), tenantId, name: "Main Branch", code: "MAIN" })
      .returning(),
  );
  const [product] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoProduct)
      .values({
        id: createId(),
        tenantId,
        name: "Limited Stock Item",
        sku: "limited-stock-item",
        price: "10.00",
        trackStock: true,
        stockQuantity: N,
      })
      .returning(),
  );

  async function checkoutOneUnit() {
    return withTenant(tenantId, (tx) =>
      checkout(tx, {
        tenantId,
        branchId: branch!.id,
        cashierUserId,
        input: {
          branchId: branch!.id,
          idempotencyKey: createId(),
          items: [{ productId: product!.id, quantity: 1 }],
          payments: [{ method: "card", amount: "10.00" }],
        } as any,
      }),
    );
  }

  console.log(`\nFiring ${N} concurrent single-unit checkouts against a product with stockQuantity: ${N}…\n`);
  const results = await Promise.allSettled(Array.from({ length: N }, () => checkoutOneUnit()));
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected");

  check(
    `exactly ${N} sales complete successfully with zero errors from legitimate attempts`,
    succeeded === N,
    `got ${succeeded} succeeded, ${failed.length} failed: ${JSON.stringify(
      failed.map((f) => (f as PromiseRejectedResult).reason?.message ?? f),
    )}`,
  );

  const [finalProduct] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoProduct).where(eq(chronoProduct.id, product!.id)),
  );
  check(
    "final stockQuantity is exactly 0, never negative",
    finalProduct?.stockQuantity === 0,
    `got ${finalProduct?.stockQuantity}`,
  );

  let oversoldRejected = false;
  try {
    await checkoutOneUnit();
  } catch (err: any) {
    oversoldRejected = err?.status === 409 || /insufficient stock/i.test(err?.message ?? "");
  }
  check(
    "one more checkout after stock hits 0 fails with 409 insufficient stock",
    oversoldRejected,
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
