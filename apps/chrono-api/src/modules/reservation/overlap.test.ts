/**
 * Overlap concurrency test (reservations Phase 3, `.ai/plans/chrono/active/
 * reservations/README.md` — "Overlap concurrency" / the Phase 3 deliverable
 * left unwritten by the previous pass).
 *
 * Proves `assertNoOverlap`'s row-lock-then-validate guard (routes.ts) actually
 * serializes concurrent bookings under REAL concurrent Postgres connections —
 * not just that it typechecks. PGlite cannot exercise this: it is a single
 * in-process connection, so it can never reproduce genuine concurrent-
 * connection row-lock contention (the same limitation the `pos` plan notes
 * for its own stock-oversell concurrency test, `.ai/plans/chrono/active/pos/
 * README.md`, and `wallet`'s concurrency test before it).
 *
 * Standalone tsx script (no unit-test runner in this repo) — mirrors the
 * inline assertion style of `e2e/run.ts` / `e2e/permissions.test.ts`: seeds
 * one tenant/branch/station via the real Hono app + a REAL Postgres
 * connection, starts the real HTTP server, fires N concurrent
 * `POST /rpc/reservations` requests for the identical `[startAt, endAt)`
 * window, and asserts exactly one `201` + N-1 `409`s, confirmed by a direct
 * DB query afterward.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod — see `apps/chrono-api/.env.example`). Skips gracefully with a
 * clear message when it isn't set, so this never runs destructively by
 * accident and never crashes confusingly in an environment that hasn't
 * configured it.
 */
import "dotenv/config";
import { is, Column } from "drizzle-orm";
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
      // Include the index's `.where()` predicate SQL when present — a partial
      // unique index (e.g. chrono_reservation_one_active_per_member_uq) applies
      // as a FULL unique constraint if this is dropped, causing false
      // collisions unrelated to the invariant it's meant to enforce
      // (reservations-queue-and-self-service plan, round-2 audit CONDITION 5).
      const where = i.config.where;
      const whereSql = where ? ` where ${sqlToText(where)}` : "";
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols})${whereSql};`;
    });
}

/**
 * Renders a Drizzle SQL fragment (from a partial index's `.where()`) to plain
 * text — only handles what this codebase's own `.where(sql\`...\`)` calls
 * actually produce: plain string chunks and interpolated Column references
 * (e.g. `sql\`${t.status} in (...)\``, the existing pattern in
 * session/schema.ts's own partial index). Not a general SQL-to-string printer.
 */
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
      "\noverlap.test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the reservation double-booking guard under REAL\n" +
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

  // A direct (non-pooled) connection, and NO cap on pool size: unlike
  // e2e/run.ts (which needs one persistent SET ROLE connection), this test's
  // entire point is genuine concurrent connections racing the row lock — a
  // DB_POOL_MAX=1 pool would serialize the requests itself and prove nothing.
  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();

  // TEST_DATABASE_URL's credential (chrono_app) is the real NOBYPASSRLS,
  // DML-only app role (`.ai/rules/database.md`) — by design it cannot CREATE
  // tables/indexes. Schema setup + RLS application need an owner-capable
  // connection, exactly like DATABASE_URL_ADMIN does for the dev database;
  // reuse DATABASE_URL_ADMIN's credentials but point them at the TEST
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
  console.log(`\noverlap.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  // Common app env — mirrors e2e/run.ts's minimal boot set.
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
  const { chronoStation } = await import("../station/schema");
  const { chronoReservation } = await import("./schema");
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
  // Drizzle's table config has no notion of an EXCLUDE constraint (it isn't
  // expressible in the schema — see schema.ts's comment), so `tableDdl` above
  // never emits it. Apply the SAME constraint the real migration
  // (drizzle/0011_add_reservation_overlap_exclusion.sql) hand-writes, so this
  // test actually exercises the exclusion-constraint guarantee under
  // concurrency — not just the app-level `SELECT ... FOR UPDATE` pre-check.
  await adminPool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
  // reservations-queue-and-self-service plan rewrote this constraint's WHERE to
  // also cover "hold" (a live, station-locking claim window created once a
  // reservation activates or a queued member is promoted) and to require
  // "startAt" IS NOT NULL — Postgres treats tsrange(NULL,NULL) as an UNBOUNDED
  // range, not "no range", so a NULL-windowed "pending" row must be excluded by
  // this predicate explicitly, not just by omission from the status list.
  await adminPool.query(`ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_no_overlap"
    EXCLUDE USING gist (
      "tenantId" WITH =,
      "stationId" WITH =,
      tsrange("startAt", "endAt", '[)') WITH &&
    ) WHERE (status IN ('confirmed', 'checked_in', 'hold') AND "startAt" IS NOT NULL);`);
  // CHECK constraint mirrored from the real migration (Phase 1) — a queue row
  // (fromQueue=true, status='pending') has no window until promoted, and must
  // capture requestedDurationMinutes at join time or promotion has nothing to
  // compute endAt from.
  await adminPool.query(`ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_pending_window_check"
    CHECK (
      (status = 'pending' AND "startAt" IS NULL AND "endAt" IS NULL
        AND ("fromQueue" = false OR "requestedDurationMinutes" IS NOT NULL))
      OR ("startAt" IS NOT NULL AND "endAt" IS NOT NULL)
    );`);
  // Grant the app role (DATABASE_URL / chrono_app) DML on the tables just
  // created by the admin role — mirrors provisionAppRole's default privileges,
  // needed here because the tables are newly created by a different owner.
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  // 4. Seed one tenant + staff owner + branch + station.
  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@overlap.test", password: PW, name: "Overlap Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "overlap", name: "Overlap Co" });
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
  const [station] = await withTenant(tenantId, (tx) =>
    tx
      .insert(chronoStation)
      .values({
        id: createId(),
        tenantId,
        branchId: branch!.id,
        name: "Station 1",
        stationNumber: "1",
      })
      .returning(),
  );

  // 5. Unlike e2e/run.ts's PGlite/self-provisioned path, DATABASE_URL here is
  // ALREADY the real, restricted `chrono_app` role (`.ai/rules/database.md`:
  // NOBYPASSRLS, DML-only) — no BYPASSRLS-owner fallback to guard against, and
  // no per-connection SET ROLE needed. RLS is genuinely enforced for the HTTP
  // phase below as-is.

  // 6. Start the real HTTP server on an ephemeral port.
  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const r2 = await auth.api.signInEmail({
    body: { email: "owner@overlap.test", password: PW },
    asResponse: true,
  });
  const ownerCookie = jar(r2.headers.getSetCookie());

  async function createReservation(): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/rpc/reservations`, {
      method: "POST",
      headers: {
        "x-tenant-slug": "overlap",
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        branchId: branch!.id,
        stationId: station!.id,
        customerName: "Race Customer",
        startAt: "2030-01-01T10:00:00.000Z",
        endAt: "2030-01-01T11:00:00.000Z",
      }),
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

  console.log(`\nFiring ${N} concurrent POST /rpc/reservations for the identical window…\n`);
  const results = await Promise.all(Array.from({ length: N }, () => createReservation()));
  const okCount = results.filter((r) => r.status === 201).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  check(
    `exactly one 201 among ${N} concurrent identical-window requests`,
    okCount === 1,
    `got ${okCount} × 201, statuses: ${results.map((r) => r.status).join(",")}`,
  );
  check(
    `exactly ${N - 1} × 409 among the rest`,
    conflictCount === N - 1,
    `got ${conflictCount} × 409`,
  );
  check("no unexpected status codes", other.length === 0, JSON.stringify(other));

  // 7. Confirm at the DB level: exactly one row exists for this station+window.
  const { eq, and } = await import("agora/db");
  const dbRows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoReservation)
      .where(and(eq(chronoReservation.stationId, station!.id), eq(chronoReservation.tenantId, tenantId))),
  );
  check(
    "exactly one ChronoReservations row exists for this station/window",
    dbRows.length === 1,
    `got ${dbRows.length} rows`,
  );

  // 8. Boundary behaviour: the exclusion constraint uses `tsrange(startAt,
  // endAt, '[)')` — half-open — so a booking ENDING exactly at 14:00 must NOT
  // conflict with one STARTING exactly at 14:00 on the same station. Uses a
  // separate window/day from the race above so it is unaffected by the single
  // row that race left behind.
  async function createBoundaryReservation(startAt: string, endAt: string) {
    const res = await fetch(`${base}/rpc/reservations`, {
      method: "POST",
      headers: {
        "x-tenant-slug": "overlap",
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        branchId: branch!.id,
        stationId: station!.id,
        customerName: "Boundary Customer",
        startAt,
        endAt,
      }),
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

  console.log("\nBoundary check: one ending 14:00, one starting 14:00…\n");
  const first = await createBoundaryReservation(
    "2030-02-01T12:00:00.000Z",
    "2030-02-01T14:00:00.000Z",
  );
  const second = await createBoundaryReservation(
    "2030-02-01T14:00:00.000Z",
    "2030-02-01T16:00:00.000Z",
  );
  check(
    "back-to-back booking ending 14:00 succeeds (201)",
    first.status === 201,
    `got ${first.status}: ${JSON.stringify(first.body)}`,
  );
  check(
    "back-to-back booking starting 14:00 does NOT conflict (201, half-open interval)",
    second.status === 201,
    `got ${second.status}: ${JSON.stringify(second.body)}`,
  );

  // 9. `hold`-status regression (reservations-queue-and-self-service plan,
  // round-2 audit's required regression case): a live "hold" — the state a
  // direct reservation activates into at startAt, or a promoted queue member
  // lands in — must be just as protected by the exclusion constraint as
  // "confirmed"/"checked_in". Insert one directly (no route creates "hold" yet
  // — that's the background sweep, a later phase) and confirm an overlapping
  // booking attempt through the real API still 409s.
  console.log("\nHold-status overlap check: booking over a live hold must 409…\n");
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoReservation).values({
      id: createId(),
      tenantId,
      branchId: branch!.id,
      stationId: station!.id,
      customerName: "Held Customer",
      status: "hold",
      startAt: new Date("2030-03-01T10:00:00.000Z"),
      endAt: new Date("2030-03-01T11:00:00.000Z"),
      holdExpiresAt: new Date("2030-03-01T10:30:00.000Z"),
    }),
  );
  const holdOverlap = await createBoundaryReservation(
    "2030-03-01T10:15:00.000Z",
    "2030-03-01T10:45:00.000Z",
  );
  check(
    "booking overlapping a live hold is refused (409)",
    holdOverlap.status === 409,
    `got ${holdOverlap.status}: ${JSON.stringify(holdOverlap.body)}`,
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
