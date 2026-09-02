/**
 * Wallet concurrency test (wallet Phase 3, `.ai/plans/chrono/active/wallet/
 * README.md` — Phase 3's own required deliverable).
 *
 * Proves `lockWalletForUpdate`'s `SELECT ... FOR UPDATE` row lock actually
 * serializes concurrent credit/debit calls under REAL concurrent Postgres
 * connections — not just that it typechecks. PGlite cannot exercise this: it
 * is a single in-process connection, so it can never reproduce genuine
 * concurrent-connection row-lock contention (same limitation noted by
 * `reservations`' overlap.test.ts and the `pos` plan's own stock-oversell
 * concurrency test).
 *
 * Standalone tsx script (no unit-test runner in this repo) — mirrors
 * reservation/overlap.test.ts's scaffold: resets and re-migrates a dedicated
 * *test*-named database, seeds one tenant + one tenantMember, fires N
 * concurrent creditWallet/debitWallet calls against the same memberId over
 * REAL separate Postgres connections, and asserts: (a) the final balance
 * equals the arithmetic sum of every delta (no lost update); (b) the
 * transaction-row count equals the call count (no dropped/duplicated ledger
 * rows); (c) replaying the ledger in createdAt order reconstructs the same
 * final balance (the self-checking invariant).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const CREDIT_COUNT = 10;
const DEBIT_COUNT = 10;
const CREDIT_AMOUNT = "10.00";
const DEBIT_AMOUNT = "5.00";

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
      "\nwallet concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the wallet row-lock guard under REAL concurrent\n" +
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
  console.log(`\nwallet concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

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
  const { chronoWallet, chronoWalletTransaction } = await import("./schema");
  const { creditWallet, debitWallet } = await import("./service");
  const { createId } = await import("agora");
  const { eq, and, asc } = await import("agora/db");

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

  // 4. Seed one tenant + one tenantMember (customer).
  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "wallet-concurrency",
    name: "Wallet Concurrency Co",
  });
  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "customer@wallet-concurrency.test",
      name: "Concurrency Customer",
      passwordHash: "unused-in-this-test",
    }),
  );

  console.log(
    `\nFiring ${CREDIT_COUNT} concurrent credits of ${CREDIT_AMOUNT} and ${DEBIT_COUNT} concurrent debits of ${DEBIT_AMOUNT} against the same memberId…\n`,
  );

  const creditCalls = Array.from({ length: CREDIT_COUNT }, () =>
    withTenant(tenantId, (tx) =>
      creditWallet(tx, {
        tenantId,
        memberId,
        amount: CREDIT_AMOUNT,
        reason: "concurrency test credit",
      }),
    ),
  );
  const debitCalls = Array.from({ length: DEBIT_COUNT }, () =>
    withTenant(tenantId, (tx) =>
      debitWallet(tx, {
        tenantId,
        memberId,
        amount: DEBIT_AMOUNT,
        reason: "concurrency test debit",
      }),
    ),
  );

  const results = await Promise.allSettled([...creditCalls, ...debitCalls]);
  const rejected = results.filter((r) => r.status === "rejected");
  check(
    "no call was rejected (a 422 here would mean debits raced ahead of credits — expected to interleave safely since the row lock serializes them)",
    rejected.length === 0,
    JSON.stringify(rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? r)),
  );

  // Expected final balance: every credit/debit actually applied (0 starting
  // balance + N credits − N debits, since CREDIT_AMOUNT > DEBIT_AMOUNT so no
  // debit ever needs to be rejected for insufficient funds regardless of
  // ordering).
  const expectedCents =
    BigInt(Math.round(Number(CREDIT_AMOUNT) * 100)) * BigInt(CREDIT_COUNT) -
    BigInt(Math.round(Number(DEBIT_AMOUNT) * 100)) * BigInt(DEBIT_COUNT);
  const expectedBalance = (Number(expectedCents) / 100).toFixed(2);

  const [wallet] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoWallet).where(eq(chronoWallet.memberId, memberId)),
  );
  check(
    `final balance equals the arithmetic sum of every delta (expected ${expectedBalance})`,
    wallet?.balance === expectedBalance,
    `got ${wallet?.balance}`,
  );

  const transactions = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoWalletTransaction)
      .where(
        and(
          eq(chronoWalletTransaction.tenantId, tenantId),
          eq(chronoWalletTransaction.memberId, memberId),
        ),
      )
      .orderBy(asc(chronoWalletTransaction.createdAt)),
  );
  check(
    `transaction-row count equals the call count (${CREDIT_COUNT + DEBIT_COUNT})`,
    transactions.length === CREDIT_COUNT + DEBIT_COUNT,
    `got ${transactions.length} rows`,
  );

  // Replay the ledger in createdAt order — reconstructing the final balance
  // from scratch proves no row was lost or double-counted, independent of
  // the wallet.balance column itself.
  let replayed = 0n;
  for (const t of transactions) {
    replayed += BigInt(Math.round(Number(t.amount) * 100));
  }
  const replayedBalance = (Number(replayed) / 100).toFixed(2);
  check(
    "replaying the ledger in createdAt order reconstructs the same final balance",
    replayedBalance === wallet?.balance,
    `replayed ${replayedBalance}, wallet.balance ${wallet?.balance}`,
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
