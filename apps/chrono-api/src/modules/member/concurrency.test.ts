/**
 * Member-profile approval guard test (member-approval-guard Phase 2,
 * `.ai/plans/chrono/active/member-approval-guard/README.md` — Phase 2's own
 * required deliverable).
 *
 * Proves `approveMemberProfile`'s conditional-UPDATE guard (Phase 1,
 * `service.ts`) actually serializes concurrent double-approve races under
 * REAL concurrent Postgres connections — not just that it typechecks.
 * Calls the SERVICE FUNCTION directly (not the route, which needs a Hono
 * Context, and not a re-implementation of the SQL, which would let removing
 * the guard from service.ts pass silently — exactly the "testing plumbing,
 * not the gate" failure `.ai/rules/rbac.md` warns against for permission
 * gates, applied here to a state guard).
 *
 * Mirrors `wallet/concurrency.test.ts`'s scaffold: resets and re-migrates a
 * dedicated `*test*`-named database, seeds one tenant + one pending member
 * profile, fires N concurrent `approveMemberProfile` calls at it, and
 * asserts: (a) exactly one succeeds; (b) N-1 raise 409; (c) `approvedAt` is
 * written exactly once. Also covers the regression cases: re-approving an
 * already-approved profile 409s with a byte-identical `approvedAt`, and
 * rejecting an approved profile succeeds (from: "approved").
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

const APPROVE_COUNT = 10;

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
      "\nmember-approval concurrency test skipped: TEST_DATABASE_URL is not set.\n" +
        "  This test proves the approve/reject guard under REAL concurrent\n" +
        "  Postgres connections. Set TEST_DATABASE_URL to a dedicated\n" +
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
  // entire point is genuine concurrent connections racing the guard; a
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
  console.log(`\nmember-approval concurrency test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

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
  const { chronoMemberProfile } = await import("./schema");
  const { createId } = await import("agora");
  const { eq, and } = await import("agora/db");
  const { approveMemberProfile, rejectMemberProfile } = await import("./service");
  const { HttpError } = await import("agora/server");

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
    slug: "member-approval-concurrency",
    name: "Member Approval Concurrency Co",
  });
  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "applicant@member-approval.test",
      name: "Applicant",
      passwordHash: "unused-in-this-test",
    }),
  );
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoMemberProfile).values({
      id: createId(),
      tenantId,
      memberId,
      applicationStatus: "pending",
    }),
  );

  console.log(`\nFiring ${APPROVE_COUNT} concurrent approves at the same pending profile…\n`);

  const results = await Promise.allSettled(
    Array.from({ length: APPROVE_COUNT }, () =>
      withTenant(tenantId, (tx) => approveMemberProfile(tx, { tenantId, memberId })),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  const non409 = rejected.filter(
    (r) => !(r.reason instanceof HttpError) || r.reason.status !== 409,
  );

  check("exactly one concurrent approve succeeded", fulfilled.length === 1, `succeeded = ${fulfilled.length}`);
  check(
    `exactly ${APPROVE_COUNT - 1} concurrent approves raised 409`,
    rejected.length === APPROVE_COUNT - 1,
    `rejected = ${rejected.length}`,
  );
  check("every rejection was a 409, none an unexpected error", non409.length === 0, JSON.stringify(non409.map((r) => r.reason)));

  const [afterFirstBatch] = await withTenant(tenantId, (tx) =>
    tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus, approvedAt: chronoMemberProfile.approvedAt })
      .from(chronoMemberProfile)
      .where(and(eq(chronoMemberProfile.tenantId, tenantId), eq(chronoMemberProfile.memberId, memberId)))
      .limit(1),
  );
  check("profile is approved after the race", afterFirstBatch?.applicationStatus === "approved");
  check("approvedAt was written (non-null)", afterFirstBatch?.approvedAt != null);
  const firstApprovedAt = afterFirstBatch?.approvedAt ?? null;

  // Regression: re-approving an already-approved profile 409s and leaves
  // approvedAt byte-identical.
  let reApproveRejected = false;
  try {
    await withTenant(tenantId, (tx) => approveMemberProfile(tx, { tenantId, memberId }));
  } catch (err) {
    reApproveRejected = err instanceof HttpError && err.status === 409;
  }
  check("re-approving an already-approved profile returns 409", reApproveRejected);

  const [afterReapprove] = await withTenant(tenantId, (tx) =>
    tx
      .select({ approvedAt: chronoMemberProfile.approvedAt })
      .from(chronoMemberProfile)
      .where(and(eq(chronoMemberProfile.tenantId, tenantId), eq(chronoMemberProfile.memberId, memberId)))
      .limit(1),
  );
  check(
    "approvedAt is byte-identical after the redundant re-approve",
    afterReapprove?.approvedAt?.getTime() === firstApprovedAt?.getTime(),
  );

  // Regression: rejecting an approved profile succeeds (from: "approved").
  const { previousStatus: rejectPreviousStatus } = await withTenant(tenantId, (tx) =>
    rejectMemberProfile(tx, { tenantId, memberId }),
  );
  check("rejecting an approved profile succeeds, reporting from: \"approved\"", rejectPreviousStatus === "approved");

  const [afterReject] = await withTenant(tenantId, (tx) =>
    tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(and(eq(chronoMemberProfile.tenantId, tenantId), eq(chronoMemberProfile.memberId, memberId)))
      .limit(1),
  );
  check("profile is rejected after the regression call", afterReject?.applicationStatus === "rejected");

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
