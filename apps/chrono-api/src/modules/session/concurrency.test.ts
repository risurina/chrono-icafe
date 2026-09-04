/**
 * Session close concurrency test (sessions Phase 3, `.ai/plans/chrono/active/
 * sessions/README.md` — Phase 3's own required deliverable).
 *
 * Proves `closeSession`'s row lock (`SELECT ... FOR UPDATE`) actually
 * serializes a manual end racing the (future) expiry sweep — a racing caller
 * that loses the lock sees the row already `ended` and gets
 * `alreadyClosed: true`, never a double-close or a double wallet debit.
 * PGlite cannot exercise this (same limitation noted by `reservations`'
 * overlap.test.ts and `wallet`'s concurrency.test.ts before it).
 *
 * Standalone tsx script — mirrors wallet/concurrency.test.ts's scaffold:
 * resets and re-migrates a dedicated *test*-named database, seeds one tenant
 * + branch + station + station group + tenantMember + wallet with a starting
 * balance, starts one session, fires N concurrent closeSession calls over
 * REAL separate Postgres connections, and asserts: (a) exactly one call
 * performed the close (alreadyClosed === false on exactly one, true on the
 * rest); (b) exactly one ChronoWalletTransactions row was created for the
 * session (no double-billing); (c) the station's status is "available"
 * (not corrupted by a second racing writer).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is, Column } from "drizzle-orm";
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
      "\nsession concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the session-close row-lock guard under REAL\n" +
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
  console.log(`\nsession concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

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
  const { chronoWallet, chronoWalletTransaction } = await import("../wallet/schema");
  const { chronoSession } = await import("./schema");
  const { closeSession } = await import("./service");
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
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "session-concurrency",
    name: "Session Concurrency Co",
  });
  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "customer@session-concurrency.test",
      name: "Concurrency Customer",
      passwordHash: "unused-in-this-test",
    }),
  );
  const [branch] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoBranch)
      .values({ id: createId(), tenantId, name: "Main Branch", code: "MAIN" })
      .returning(),
  );
  const [group] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoStationGroup)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        name: "Standard",
        code: "STD",
        hourlyRate: "60.00",
      })
      .returning(),
  );
  const [station] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoStation)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationGroupId: group!.id,
        name: "Station 1",
        stationNumber: "1",
        status: "occupied",
      })
      .returning(),
  );
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoWallet).values({ tenantId, memberId, balance: "1000.00" }),
  );
  // Backdated 30 minutes so closeSession computes a real non-zero charge —
  // otherwise every concurrent call would correctly compute a 0.00 charge
  // and this test wouldn't exercise the double-billing guard at all.
  const startedAt = new Date(Date.now() - 30 * 60_000);
  const [session] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoSession)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station!.id,
        memberId,
        status: "active",
        startedAt,
        rateSnapshot: "60.00",
        rateSource: "group_hourly",
      })
      .returning(),
  );

  console.log(`\nFiring ${N} concurrent closeSession calls against the same session…\n`);
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      withTenant(tenantId, (tx) =>
        closeSession(tx, { tenantId, sessionId: session!.id, performedByUserId: null }),
      ),
    ),
  );
  const closedCount = results.filter((r) => r.alreadyClosed === false).length;
  const alreadyClosedCount = results.filter((r) => r.alreadyClosed === true).length;

  check(
    `exactly one of ${N} concurrent calls performed the close`,
    closedCount === 1,
    `got ${closedCount} closed, ${alreadyClosedCount} alreadyClosed`,
  );
  check(
    `the other ${N - 1} calls correctly saw alreadyClosed: true`,
    alreadyClosedCount === N - 1,
  );

  const transactions = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoWalletTransaction)
      .where(
        and(
          eq(chronoWalletTransaction.tenantId, tenantId),
          eq(chronoWalletTransaction.referenceType, "session"),
          eq(chronoWalletTransaction.referenceId, session!.id),
        ),
      ),
  );
  check(
    "exactly one ChronoWalletTransactions row was created for this session (no double-billing)",
    transactions.length === 1,
    `got ${transactions.length} rows`,
  );

  const [finalStation] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoStation).where(eq(chronoStation.id, station!.id)),
  );
  check(
    'station status is "available" (not corrupted by a second racing writer)',
    finalStation?.status === "available",
    `got ${finalStation?.status}`,
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
