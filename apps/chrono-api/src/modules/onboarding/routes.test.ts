/**
 * Onboarding checklist acceptance test (onboarding-checklist Phase 3,
 * `.ai/plans/chrono/active/onboarding-checklist/README.md` — Phase 3's own
 * required deliverable).
 *
 * Proves, against real Postgres, that `resolveOnboardingState` (the single
 * implementation both this plan's routes and `onboarding-wizard`'s route
 * depend on):
 * (a) done flags flip against real tenant state (create a branch -> the
 *     createBranch item flips to done on the next resolve);
 * (b) dismissal persists per (tenantId, userId) and the next resolve reflects
 *     it, WITHOUT hiding another user's card on the same tenant;
 * (c) a dismissed resolve runs ZERO probes — asserted directly via a probe
 *     call counter, not just "no delivery";
 * (d) cross-tenant isolation — tenant A's state never reflects tenant B's
 *     branches/stations/members.
 *
 * Mirrors `member/concurrency.test.ts`'s scaffold (minus the concurrency
 * part): resets and re-migrates a dedicated `*test*`-named database, calls
 * the SERVICE FUNCTION directly (not HTTP + a mocked Hono context).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

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
      "\nonboarding-checklist test skipped: TEST_DATABASE_URL is not set.\n" +
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
  console.log(`\nonboarding-checklist test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES, eq } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { createId } = await import("agora");
  const { chronoBranch } = await import("../branch/schema");
  const { tenantOnboardingDismissal } = await import("agora/db/schema");
  const contractsModule = await import("./contracts");
  const { resolveOnboardingState } = await import("./service");

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

  console.log("  seeding two tenants…");
  const tenantAId = createId();
  const tenantBId = createId();
  await adminDb.insert(schema.organization).values([
    { id: tenantAId, slug: "onboarding-a", name: "Onboarding A" },
    { id: tenantBId, slug: "onboarding-b", name: "Onboarding B" },
  ]);

  const ownerUserId = createId();
  const otherUserId = createId();
  await adminDb.insert(schema.user).values([
    {
      id: ownerUserId,
      email: "owner@onboarding-a.test",
      name: "Owner",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: otherUserId,
      email: "other@onboarding-a.test",
      name: "Other",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const OWNER_PERMISSIONS: Record<string, string[]> = {
    branch: ["create", "update"],
    station: ["create", "update", "delete"],
    staff: ["invite"],
    pos: ["read", "sell", "void", "manageProducts"],
    device: ["approve", "revoke", "manage"],
    shift: ["open", "close", "closeAny"],
  };

  // (a) an empty tenant A resolves with nothing done.
  const before = await resolveOnboardingState(tenantAId, ownerUserId, OWNER_PERMISSIONS);
  check(
    "a fresh tenant's createBranch item starts not done",
    before.items.find((i) => i.key === "createBranch")?.done === false,
  );
  check("total is 7 (all seven items present)", before.total === 7, `total = ${before.total}`);
  check("dismissed starts false", before.dismissed === false);

  // (a) creating a branch in tenant A flips createBranch to done on the next resolve.
  await withTenant(tenantAId, (tx) =>
    tx.insert(chronoBranch).values({ id: createId(), tenantId: tenantAId, name: "Branch 1", code: "B1" }),
  );
  const afterBranch = await resolveOnboardingState(tenantAId, ownerUserId, OWNER_PERMISSIONS);
  check(
    "createBranch flips to done after a branch is created",
    afterBranch.items.find((i) => i.key === "createBranch")?.done === true,
  );
  check(
    "completedCount reflects exactly one done item",
    afterBranch.completedCount === 1,
    `completedCount = ${afterBranch.completedCount}`,
  );

  // (d) tenant B (empty) must never see tenant A's branch.
  const tenantBState = await resolveOnboardingState(tenantBId, ownerUserId, OWNER_PERMISSIONS);
  check(
    "tenant B's createBranch stays not done despite tenant A's branch existing",
    tenantBState.items.find((i) => i.key === "createBranch")?.done === false,
  );
  check(
    "tenant B's completedCount is 0 (cross-tenant isolation)",
    tenantBState.completedCount === 0,
    `completedCount = ${tenantBState.completedCount}`,
  );

  // Permission-aware actionable flag: a permission set with nothing granted
  // marks the branch/staff/pos/device items non-actionable but still done=false
  // and still counted in total.
  const staffLikeState = await resolveOnboardingState(tenantBId, otherUserId, {});
  check(
    "an item requiring a permission the viewer lacks is not actionable",
    staffLikeState.items.find((i) => i.key === "createBranch")?.actionable === false,
  );
  check(
    "a permission-gated item still counts toward total even when not actionable",
    staffLikeState.total === 7,
  );

  // (b) dismissal is per (tenantId, userId) — ownerUserId dismissing must not
  // hide otherUserId's card on the same tenant.
  await withTenant(tenantAId, (tx) =>
    tx.insert(tenantOnboardingDismissal).values({
      id: createId(),
      tenantId: tenantAId,
      userId: ownerUserId,
    }),
  );
  const ownerAfterDismiss = await resolveOnboardingState(tenantAId, ownerUserId, OWNER_PERMISSIONS);
  check("dismissed is true for the user who dismissed", ownerAfterDismiss.dismissed === true);
  check("items is empty once dismissed", ownerAfterDismiss.items.length === 0);

  const otherAfterOwnerDismiss = await resolveOnboardingState(tenantAId, otherUserId, OWNER_PERMISSIONS);
  check(
    "a different user on the same tenant is NOT affected by the owner's dismissal",
    otherAfterOwnerDismiss.dismissed === false,
  );
  check(
    "the other user's card still shows real items after the owner dismissed",
    otherAfterOwnerDismiss.items.length === 7,
  );

  // (c) a dismissed resolve must run ZERO probes — instrument every item's
  // probe with a call counter and confirm none fire once dismissed. The
  // registry is `as const`, so this cast targets only the mutable shape the
  // instrumentation needs — not `any`.
  type MutableProbe = { probe: (typeof contractsModule.CHRONO_ONBOARDING_ITEMS)[keyof typeof contractsModule.CHRONO_ONBOARDING_ITEMS]["probe"] };
  let probeCalls = 0;
  for (const item of Object.values(contractsModule.CHRONO_ONBOARDING_ITEMS)) {
    const mutable = item as unknown as MutableProbe;
    const original = mutable.probe;
    mutable.probe = async (tx, tenantId) => {
      probeCalls++;
      return original(tx, tenantId);
    };
  }
  probeCalls = 0;
  await resolveOnboardingState(tenantAId, ownerUserId, OWNER_PERMISSIONS);
  check("a dismissed resolve runs zero probes", probeCalls === 0, `probeCalls = ${probeCalls}`);

  probeCalls = 0;
  await resolveOnboardingState(tenantAId, otherUserId, OWNER_PERMISSIONS);
  check(
    "a non-dismissed resolve runs all seven probes",
    probeCalls === 7,
    `probeCalls = ${probeCalls}`,
  );

  await adminDb.delete(schema.organization).where(eq(schema.organization.id, tenantAId));

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
