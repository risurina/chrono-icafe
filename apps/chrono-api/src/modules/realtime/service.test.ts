/**
 * Station-transition publish test (realtime-updates Phase 2a,
 * `.ai/plans/chrono/active/realtime-updates/README.md` — Phase 2a's own
 * required deliverable).
 *
 * Proves `publishStationTransition` (`station/routes.ts`, shared by the
 * station module and `device/routes.ts`'s approve handler) publishes a
 * correctly-shaped `station.status` event on the station's branch channel,
 * and a `branch.summary` whose counts match the real `chronoStation` rows for
 * that branch — against a REAL Postgres connection and the REAL in-memory
 * realtime provider, not mocks.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database). Skips
 * gracefully with a clear message when it isn't set.
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
      "\nstation realtime-publish test skipped: TEST_DATABASE_URL is not set.\n" +
        "  Set TEST_DATABASE_URL to a dedicated *test*-named database to run it.\n",
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
  console.log(`\nstation realtime-publish test mode: REAL database "${dbName}"`);

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
  const { chronoStation } = await import("../station/schema");
  const { eq } = await import("agora/db");
  const { publishStationTransition } = await import("../station/routes");
  const { getRealtimeProvider, tenantScopeChannel } = await import("agora/realtime");
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
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId,
    slug: "realtime-publish",
    name: "Realtime Publish Co",
  });
  const branchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({ id: branchId, tenantId, name: "Main", code: "MAIN" }),
  );

  const stationAId = createId();
  const stationBId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStation).values([
      { id: stationAId, tenantId, branchId, name: "PC-1", stationNumber: "1", status: "available" },
      { id: stationBId, tenantId, branchId, name: "PC-2", stationNumber: "2", status: "occupied" },
    ]),
  );

  const provider = getRealtimeProvider();
  const statusEvents: unknown[] = [];
  const summaryEvents: unknown[] = [];
  await provider.subscribe(tenantScopeChannel(tenantId, `branch:${branchId}`), (_event, payload) => {
    statusEvents.push(payload);
  });
  await provider.subscribe(
    tenantScopeChannel(tenantId, `branch-summary:${branchId}`),
    (_event, payload) => {
      summaryEvents.push(payload);
    },
  );

  // Mirror real caller order: the write commits first (stationA flips from
  // "available" to "occupied"), then publishStationTransition announces it —
  // publishStationTransition itself never writes, matching every real call
  // site (station create/update, device approve).
  await withTenant(tenantId, (tx) =>
    tx.update(chronoStation).set({ status: "occupied" }).where(eq(chronoStation.id, stationAId)),
  );
  await publishStationTransition(tenantId, { id: stationAId, branchId, status: "occupied" });

  check("exactly one station.status event published", statusEvents.length === 1);
  check(
    "station.status payload matches the transitioned station",
    JSON.stringify(statusEvents[0]) ===
      JSON.stringify({ stationId: stationAId, branchId, status: "occupied" }),
    JSON.stringify(statusEvents[0]),
  );
  check("exactly one branch.summary event published", summaryEvents.length === 1);
  check(
    "branch.summary reflects both stations now occupied (real committed DB state, not the publish payload)",
    JSON.stringify(summaryEvents[0]) ===
      JSON.stringify({
        branchId,
        counts: { available: 0, occupied: 2, maintenance: 0, offline: 0 },
        total: 2,
      }),
    JSON.stringify(summaryEvents[0]),
  );

  // A station in a DIFFERENT branch's transition must never publish to this
  // branch's channels — tenant/branch isolation for the channel-keyed model.
  const otherBranchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({ id: otherBranchId, tenantId, name: "Other", code: "OTHER" }),
  );
  const otherStationId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoStation).values({
      id: otherStationId,
      tenantId,
      branchId: otherBranchId,
      name: "PC-9",
      stationNumber: "9",
      status: "available",
    }),
  );
  await publishStationTransition(tenantId, {
    id: otherStationId,
    branchId: otherBranchId,
    status: "maintenance",
  });
  check(
    "a different branch's transition does not publish to this branch's channel",
    statusEvents.length === 1 && summaryEvents.length === 1,
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
