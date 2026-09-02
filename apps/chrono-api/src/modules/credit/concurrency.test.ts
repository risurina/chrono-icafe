/**
 * Credit concurrency test (credits Phase 3, `.ai/plans/chrono/active/credits/
 * README.md` — Phase 3's own required deliverable).
 *
 * Proves `consumeCredits`'s `SELECT ... FOR UPDATE` row lock actually
 * serializes concurrent consumption of the same member's lots under REAL
 * concurrent Postgres connections — not just that it typechecks. PGlite
 * cannot exercise this: it is a single in-process connection, so it can
 * never reproduce genuine concurrent-connection row-lock contention (same
 * limitation noted by wallet's/reservations' own concurrency tests).
 *
 * Standalone tsx script (no unit-test runner in this repo) — mirrors
 * wallet/concurrency.test.ts's scaffold exactly: resets and re-migrates a
 * dedicated *test*-named database, seeds one tenant + tenantMember + wallet
 * + several ChronoCreditGrants rows (different priority/expiresAt/scope),
 * fires N concurrent consumeCredits calls against REAL separate Postgres
 * connections, and asserts: (a) the sum of every grant's remainingQuantity
 * decrease equals the total minutes actually consumed, with no lost update;
 * (b) the ChronoCreditGrantLedgerEntries row count equals exactly the number
 * of individual grant applications made; (c) replaying each grant's own
 * ledger entries in createdAt order reconstructs that grant's final
 * remainingQuantity (the self-checking invariant). A separate scenario
 * proves purchaseCreditProduct's atomicity: an insufficient wallet balance
 * must leave NO ChronoCreditGrants row behind.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const GRANT_COUNT_PER_CONSUME_TEST = 3;
const CONCURRENT_CONSUMES = 12;
const CONSUME_MINUTES_PER_CALL = 7;

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
      "\ncredit concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the credit-grant row-lock guard under REAL\n" +
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
    `\ncredit concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
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
  const { creditWallet } = await import("../wallet/service");
  const {
    chronoCreditProduct,
    chronoCreditGrant,
    chronoCreditPurchase,
    chronoCreditGrantLedgerEntry,
  } = await import("./schema");
  const { chronoStationGroup } = await import("../station/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { consumeCredits, purchaseCreditProduct } = await import("./service");
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

  // 4. Seed one tenant + one tenantMember (customer) + a branch/station-group
  // for the strict_group_only scenario.
  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "credit-concurrency",
    name: "Credit Concurrency Co",
  });
  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "customer@credit-concurrency.test",
      name: "Concurrency Customer",
      passwordHash: "unused-in-this-test",
    }),
  );
  const branchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({
      id: branchId,
      tenantId,
      name: "Main Branch",
      code: "main",
    }),
  );
  const stationGroupId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStationGroup).values({
      id: stationGroupId,
      tenantId,
      branchId,
      name: "Gold",
      code: "gold",
      hourlyRate: "50.00",
    }),
  );

  // ── Scenario A: consumeCredits concurrency ──────────────────────────────
  console.log(
    `\nScenario A: seeding ${GRANT_COUNT_PER_CONSUME_TEST} grants and firing ${CONCURRENT_CONSUMES} concurrent consumeCredits(${CONSUME_MINUTES_PER_CALL}) calls…\n`,
  );

  // Three grants: different priority/expiry/scope, enough total balance to
  // absorb every concurrent call without a shortfall (so the lost-update
  // check is meaningful — a shortfall would also legitimately reduce the
  // total consumed).
  const totalMinutesPerGrant = 100;
  const grantIds: string[] = [];
  const grantSeeds = [
    { priority: 10, expiresAt: null as Date | null, stationGroupId: null as string | null, creditPolicy: "any_station" },
    { priority: 50, expiresAt: new Date(Date.now() + 86_400_000 * 30), stationGroupId: null, creditPolicy: "any_station" },
    { priority: 100, expiresAt: null, stationGroupId, creditPolicy: "strict_group_only" },
  ];
  for (const seed of grantSeeds) {
    const id = createId();
    grantIds.push(id);
    await withTenant(tenantId, (tx) =>
      tx.insert(chronoCreditGrant).values({
        id,
        tenantId,
        memberId,
        stationGroupId: seed.stationGroupId,
        creditPolicy: seed.creditPolicy,
        originalQuantity: totalMinutesPerGrant,
        remainingQuantity: totalMinutesPerGrant,
        priority: seed.priority,
        expiresAt: seed.expiresAt,
      }),
    );
  }
  const totalAvailable = totalMinutesPerGrant * grantSeeds.length;
  const totalRequested = CONCURRENT_CONSUMES * CONSUME_MINUTES_PER_CALL;
  if (totalRequested > totalAvailable) {
    die("Test misconfiguration: totalRequested must not exceed totalAvailable.");
  }

  const consumeCalls = Array.from({ length: CONCURRENT_CONSUMES }, () =>
    withTenant(tenantId, (tx) =>
      consumeCredits(tx, {
        tenantId,
        memberId,
        quantityMinutes: CONSUME_MINUTES_PER_CALL,
        // Any-station target so the two any_station grants are eligible and
        // the strict_group_only grant is correctly skipped (score 99).
        stationGroupId: null,
        reason: "concurrency test consume",
      }),
    ),
  );
  const consumeResults = await Promise.allSettled(consumeCalls);
  const rejectedConsumes = consumeResults.filter((r) => r.status === "rejected");
  check(
    "no consumeCredits call was rejected",
    rejectedConsumes.length === 0,
    JSON.stringify(rejectedConsumes.map((r) => (r as PromiseRejectedResult).reason?.message ?? r)),
  );

  const totalConsumedAcrossCalls = consumeResults
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof consumeCredits>>> => r.status === "fulfilled")
    .reduce((sum, r) => sum + r.value.consumed, 0);
  check(
    "every call consumed the full requested amount (no shortfall, enough balance seeded)",
    totalConsumedAcrossCalls === totalRequested,
    `got ${totalConsumedAcrossCalls}, expected ${totalRequested}`,
  );

  // (a) No lost update: the strict_group_only grant (index 2) must be
  // completely untouched (target was null, ineligible for it); the two
  // any_station grants' combined remaining-quantity decrease must equal
  // totalConsumedAcrossCalls exactly.
  const grantsAfter = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoCreditGrant)
      .where(and(eq(chronoCreditGrant.tenantId, tenantId), eq(chronoCreditGrant.memberId, memberId))),
  );
  const byId = new Map(grantsAfter.map((g) => [g.id, g]));
  const strictGrant = byId.get(grantIds[2]!)!;
  check(
    "the strict_group_only grant (ineligible for a null-target consume) is untouched",
    strictGrant.remainingQuantity === totalMinutesPerGrant,
    `got ${strictGrant.remainingQuantity}`,
  );
  const anyStationDecrease = [grantIds[0]!, grantIds[1]!]
    .map((id) => totalMinutesPerGrant - byId.get(id)!.remainingQuantity)
    .reduce((a, b) => a + b, 0);
  check(
    "(a) no lost update: sum of remainingQuantity decreases equals total minutes actually consumed",
    anyStationDecrease === totalConsumedAcrossCalls,
    `decrease ${anyStationDecrease}, consumed ${totalConsumedAcrossCalls}`,
  );

  // (b) Ledger row count equals exactly the number of individual grant
  // applications made across all calls.
  const totalApplications = consumeResults
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof consumeCredits>>> => r.status === "fulfilled")
    .reduce((sum, r) => sum + r.value.applications.length, 0);
  const ledgerEntries = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoCreditGrantLedgerEntry)
      .where(
        and(
          eq(chronoCreditGrantLedgerEntry.tenantId, tenantId),
          eq(chronoCreditGrantLedgerEntry.memberId, memberId),
          eq(chronoCreditGrantLedgerEntry.type, "consumed"),
        ),
      )
      .orderBy(asc(chronoCreditGrantLedgerEntry.createdAt)),
  );
  check(
    "(b) ledger-entry count equals exactly the number of individual grant applications made",
    ledgerEntries.length === totalApplications,
    `got ${ledgerEntries.length} rows, expected ${totalApplications}`,
  );

  // (c) Replaying each grant's own ledger entries in createdAt order
  // reconstructs that grant's final remainingQuantity — the self-checking
  // invariant, independent of the grant row's own column.
  let replayOk = true;
  for (const id of grantIds) {
    const entries = ledgerEntries.filter((e) => e.grantId === id);
    const replayed = totalMinutesPerGrant + entries.reduce((sum, e) => sum + e.quantityDelta, 0);
    if (replayed !== byId.get(id)!.remainingQuantity) {
      replayOk = false;
      console.log(
        `    grant ${id}: replayed ${replayed} !== actual ${byId.get(id)!.remainingQuantity}`,
      );
    }
  }
  check(
    "(c) replaying each grant's own ledger entries in createdAt order reconstructs its final remainingQuantity",
    replayOk,
  );

  // ── Scenario B: purchaseCreditProduct atomicity ─────────────────────────
  console.log("\nScenario B: purchaseCreditProduct with an underfunded wallet must leave no grant behind…\n");

  const productId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoCreditProduct).values({
      id: productId,
      tenantId,
      name: "10 Hour Gold",
      code: "gold-10h",
      status: "active",
      quantityMinutes: 600,
      priceAmount: "500.00",
    }),
  );
  // Fund the wallet with less than the product's price.
  await withTenant(tenantId, (tx) =>
    creditWallet(tx, {
      tenantId,
      memberId,
      amount: "10.00",
      reason: "underfund for atomicity test",
    }),
  );

  const grantsBefore = await withTenant(tenantId, (tx) => tx.select().from(chronoCreditGrant));
  const purchasesBefore = await withTenant(tenantId, (tx) => tx.select().from(chronoCreditPurchase));

  let purchaseThrew = false;
  let purchaseErrorMessage = "";
  try {
    await withTenant(tenantId, (tx) =>
      purchaseCreditProduct(tx, { tenantId, memberId, productId }),
    );
  } catch (err) {
    purchaseThrew = true;
    purchaseErrorMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    "purchaseCreditProduct throws (422 insufficient wallet balance) rather than partially succeeding",
    purchaseThrew,
    purchaseErrorMessage,
  );

  const grantsAfterAttempt = await withTenant(tenantId, (tx) => tx.select().from(chronoCreditGrant));
  const purchasesAfterAttempt = await withTenant(tenantId, (tx) => tx.select().from(chronoCreditPurchase));
  check(
    "purchase atomicity: no new ChronoCreditGrants row was left behind after the failed purchase",
    grantsAfterAttempt.length === grantsBefore.length,
    `before ${grantsBefore.length}, after ${grantsAfterAttempt.length}`,
  );
  check(
    "purchase atomicity: no new ChronoCreditPurchases row was left behind after the failed purchase",
    purchasesAfterAttempt.length === purchasesBefore.length,
    `before ${purchasesBefore.length}, after ${purchasesAfterAttempt.length}`,
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
