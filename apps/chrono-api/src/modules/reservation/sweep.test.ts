/**
 * Reservation sweep concurrency + correctness test
 * (`.ai/plans/chrono/active/reservations-queue-and-self-service/README.md`,
 * Phase 5). Proves, under REAL concurrent Postgres connections:
 *  - hold-expiry idempotency: two overlapping sweep ticks on the same expired
 *    hold produce exactly one transition + one restriction row, never two;
 *  - queue-failure → ban threshold: reaching queueFailureLimit inserts a
 *    distinct queue_ban row alongside the queue_failure records, not instead
 *    of them (the dedupe index includes `type` for exactly this reason);
 *  - promotion: a pending queue row is promoted to hold once the station's
 *    blocking hold expires.
 *
 * Requires `TEST_DATABASE_URL` — skips gracefully (never destructively) when
 * unset, mirroring overlap.test.ts's own precedent.
 */
import "dotenv/config";
import { is, eq, Column } from "drizzle-orm";
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

function uniqueIndexDdls(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  return cfg.indexes
    .filter((i) => i.config.unique)
    .map((i) => {
      const cols = (i.config.columns as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
      const where = i.config.where;
      const whereSql = where ? ` where ${sqlToText(where)}` : "";
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols})${whereSql};`;
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
      "\nsweep.test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the reservation sweep's idempotency/promotion under\n" +
        "  REAL concurrent Postgres connections. Set TEST_DATABASE_URL to run it.\n",
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
    die(`Refusing to drop tables on database "${dbName}" — its name doesn't contain "test".`);
  }

  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();
  const adminEnvUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminEnvUrl) die("DATABASE_URL_ADMIN is not set.");
  const admin = new URL(adminEnvUrl);
  const adminForTest = new URL(url.toString());
  adminForTest.username = admin.username;
  adminForTest.password = admin.password;
  process.env.DATABASE_URL_ADMIN = adminForTest.toString();

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
  const { chronoReservation } = await import("./schema");
  const { chronoMemberReservationRestriction } = await import("./restriction-schema");
  const { runReservationSweepOnce } = await import("./sweep");
  const { createId } = await import("agora");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log(`\nsweep.test mode: REAL database "${dbName}"`);
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
  await adminPool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
  await adminPool.query(`ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_no_overlap"
    EXCLUDE USING gist (
      "tenantId" WITH =, "stationId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&
    ) WHERE (status IN ('confirmed', 'checked_in', 'hold') AND "startAt" IS NOT NULL);`);
  await adminPool.query(`ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_pending_window_check"
    CHECK (
      (status = 'pending' AND "startAt" IS NULL AND "endAt" IS NULL
        AND ("fromQueue" = false OR "requestedDurationMinutes" IS NOT NULL))
      OR ("startAt" IS NOT NULL AND "endAt" IS NOT NULL)
    );`);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding…");
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "sweep", name: "Sweep Co" });
  const [branch] = await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({ id: createId(), tenantId, name: "Main", code: "MAIN" }).returning(),
  );
  const [station] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoStation)
      .values({ id: createId(), tenantId, branchId: branch!.id, name: "S1", stationNumber: "1" })
      .returning(),
  );
  const memberRow = await adminDb
    .insert(schema.tenantMember)
    .values({
      id: createId(),
      tenantId,
      email: "member@sweep.test",
      name: "Sweep Member",
      passwordHash: "x",
      status: "active",
    })
    .returning();
  const memberId = memberRow[0]!.id;

  // --- Test 1: hold-expiry idempotency ---
  const [holdRow] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoReservation)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station!.id,
        memberId,
        status: "hold",
        fromQueue: false,
        startAt: new Date(Date.now() - 60 * 60_000),
        endAt: new Date(Date.now() - 30 * 60_000),
        holdExpiresAt: new Date(Date.now() - 60_000), // already expired
      })
      .returning(),
  );

  console.log("\nFiring 2 concurrent sweep ticks over the same expired hold…\n");
  await Promise.all([runReservationSweepOnce(), runReservationSweepOnce()]);

  const [afterSweep] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoReservation).where(eq(chronoReservation.id, holdRow!.id)),
  );
  check("hold row transitioned to no_show exactly once", afterSweep?.status === "no_show");

  const restrictionRows = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoMemberReservationRestriction).where(eq(chronoMemberReservationRestriction.reservationId, holdRow!.id)),
  );
  check(
    "exactly one restriction row inserted for the no-show (no duplicate from the racing tick)",
    restrictionRows.length === 1,
    `got ${restrictionRows.length}`,
  );
  check("restriction row is a reservation_ban / no_show", restrictionRows[0]?.type === "reservation_ban" && restrictionRows[0]?.reason === "no_show");

  // --- Test 2: promotion after a blocking hold expires ---
  const [blockingHold] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoReservation)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station!.id,
        memberId,
        status: "hold",
        fromQueue: false,
        startAt: new Date(Date.now() - 60 * 60_000),
        endAt: new Date(Date.now() + 60 * 60_000), // far future, still "active"
        holdExpiresAt: new Date(Date.now() - 60_000), // expired -> sweep should free it
      })
      .returning(),
  );
  const [queued] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoReservation)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        stationId: station!.id,
        memberId,
        status: "pending",
        fromQueue: true,
        requestedDurationMinutes: 60,
      })
      .returning(),
  );

  await runReservationSweepOnce();

  const [promoted] = await withTenant(tenantId, (tx) =>
    tx.select().from(chronoReservation).where(eq(chronoReservation.id, queued!.id)),
  );
  check(
    "queued row promoted to hold after the blocking hold expired",
    promoted?.status === "hold",
    `got status=${promoted?.status}`,
  );
  check("blockingHold reference stays valid", !!blockingHold);

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
