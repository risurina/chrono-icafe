/**
 * Retention + stale-run sweep test (app-usage plan, Phase 3 "Verification
 * Commands" deliverable).
 *
 * Proves, against a REAL Postgres connection:
 *  - closeStaleAppUsageRuns(): a seeded open run (endedAt IS NULL) whose
 *    device's lastSeenAt is older than APP_USAGE_STALE_DEVICE_MINUTES gets
 *    force-closed with endedAt set to that lastSeenAt and
 *    closedReason: "stale_device"; a seeded open run whose device is still
 *    within the threshold is untouched.
 *  - pruneAppUsageEvents(): a seeded row older than APP_USAGE_RETENTION_DAYS
 *    is deleted; a seeded newer row is untouched.
 *
 * Mirrors `ingest.test.ts`'s setup/style (same schema-bootstrap approach, no
 * drizzle-kit needed at runtime).
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
      "\napp-usage retention.test skipped: TEST_DATABASE_URL is not set.\n" +
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
    `\napp-usage retention.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

  // Fixed, short thresholds so the seeded fixtures land cleanly on either
  // side of the boundary.
  process.env.APP_USAGE_STALE_DEVICE_MINUTES = "15";
  process.env.APP_USAGE_RETENTION_DAYS = "90";

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, withTenant, withAdmin, schema, applyRls, BASE_TENANT_TABLES, eq } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoStation } = await import("../station/schema");
  const { chronoDevice } = await import("../device/schema");
  const { chronoAppUsageEvent } = await import("./schema");
  const { createId } = await import("agora");
  const { closeStaleAppUsageRuns, pruneAppUsageEvents } = await import("./retention");

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
  const tenantId = createId();
  await adminDb
    .insert(schema.organization)
    .values({ id: tenantId, slug: "appusageretention", name: "App Usage Retention Co" });

  const now = new Date();

  const seeded = await withTenant(tenantId, async (tx) => {
    const [branch] = await tx
      .insert(chronoBranch)
      .values({ id: createId(), tenantId, name: "Main Branch", code: "MAIN" })
      .returning();
    const [station1] = await tx
      .insert(chronoStation)
      .values({ id: createId(), tenantId, branchId: branch!.id, name: "Station 1", stationNumber: "PC-01" })
      .returning();
    const [station2] = await tx
      .insert(chronoStation)
      .values({ id: createId(), tenantId, branchId: branch!.id, name: "Station 2", stationNumber: "PC-02" })
      .returning();

    // Device A: stale — lastSeenAt 30 min ago (past the 15-min threshold).
    const [deviceStale] = await tx
      .insert(chronoDevice)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station1!.id,
        deviceFingerprint: "fp-stale",
        tokenHash: "hash-stale",
        status: "approved",
        lastSeenAt: new Date(now.getTime() - 30 * 60_000),
      })
      .returning();

    // Device B: fresh — lastSeenAt 1 min ago (within the threshold).
    const [deviceFresh] = await tx
      .insert(chronoDevice)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station2!.id,
        deviceFingerprint: "fp-fresh",
        tokenHash: "hash-fresh",
        status: "approved",
        lastSeenAt: new Date(now.getTime() - 60_000),
      })
      .returning();

    const startedAt = new Date(now.getTime() - 45 * 60_000); // 45 min ago

    const [staleRun] = await tx
      .insert(chronoAppUsageEvent)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station1!.id,
        deviceId: deviceStale!.id,
        runId: "run-stale",
        category: "app",
        appName: "stale.exe",
        startedAt,
      })
      .returning();

    const [freshRun] = await tx
      .insert(chronoAppUsageEvent)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station2!.id,
        deviceId: deviceFresh!.id,
        runId: "run-fresh",
        category: "app",
        appName: "fresh.exe",
        startedAt,
      })
      .returning();

    // Prune fixtures: one row old enough to prune, one recent enough to keep.
    // Both already closed so the stale-run sweep never touches them.
    const [oldRow] = await tx
      .insert(chronoAppUsageEvent)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station1!.id,
        deviceId: deviceStale!.id,
        runId: "run-old",
        category: "app",
        appName: "old.exe",
        startedAt: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000),
        endedAt: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000 + 60_000),
        durationSeconds: 60,
        closedReason: "device_closed",
        createdAt: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000),
      })
      .returning();

    const [recentRow] = await tx
      .insert(chronoAppUsageEvent)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station2!.id,
        deviceId: deviceFresh!.id,
        runId: "run-recent",
        category: "app",
        appName: "recent.exe",
        startedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        endedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 60_000),
        durationSeconds: 60,
        closedReason: "device_closed",
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      })
      .returning();

    return {
      deviceStale: deviceStale!,
      deviceFresh: deviceFresh!,
      staleRun: staleRun!,
      freshRun: freshRun!,
      oldRow: oldRow!,
      recentRow: recentRow!,
    };
  });

  console.log("\ncloseStaleAppUsageRuns()…\n");
  const closeResult = await closeStaleAppUsageRuns();
  check("closeStaleAppUsageRuns closes exactly the one stale run", closeResult.closed === 1, String(closeResult.closed));

  const [staleAfter] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoAppUsageEvent).where(eq(chronoAppUsageEvent.id, seeded.staleRun.id)).limit(1),
  );
  check(
    "the stale run is force-closed with endedAt = device's lastSeenAt",
    staleAfter?.endedAt?.getTime() === seeded.deviceStale.lastSeenAt!.getTime(),
    JSON.stringify({ endedAt: staleAfter?.endedAt, lastSeenAt: seeded.deviceStale.lastSeenAt }),
  );
  check("the stale run's closedReason is stale_device", staleAfter?.closedReason === "stale_device");
  check(
    "the stale run's durationSeconds is frozen (non-null)",
    typeof staleAfter?.durationSeconds === "number" && staleAfter.durationSeconds >= 0,
  );

  const [freshAfter] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoAppUsageEvent).where(eq(chronoAppUsageEvent.id, seeded.freshRun.id)).limit(1),
  );
  check(
    "the fresh run (device within threshold) is untouched — still open",
    freshAfter?.endedAt === null,
  );

  console.log("\npruneAppUsageEvents()…\n");
  const pruneResult = await pruneAppUsageEvents();
  check("pruneAppUsageEvents deletes exactly the one old row", pruneResult.deleted === 1, String(pruneResult.deleted));

  const oldStillThere = await withAdmin((tx) =>
    tx.select().from(chronoAppUsageEvent).where(eq(chronoAppUsageEvent.id, seeded.oldRow.id)),
  );
  check("the old row is gone", oldStillThere.length === 0);

  const recentStillThere = await withAdmin((tx) =>
    tx.select().from(chronoAppUsageEvent).where(eq(chronoAppUsageEvent.id, seeded.recentRow.id)),
  );
  check("the recent row is untouched", recentStillThere.length === 1);

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
