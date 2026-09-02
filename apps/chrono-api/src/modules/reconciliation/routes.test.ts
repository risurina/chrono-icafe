import "dotenv/config";
import "../../auth-bootstrap";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { Hono } from "hono";
import { reconciliationRoutes } from "./routes";
import { createId } from "agora";
import { HttpError, type TenantVars } from "agora/server";
import type { ShiftReconciliationResponse } from "./contracts";

// Helper to construct DDL for missing tables
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
      "\nreconciliation route test skipped: TEST_DATABASE_URL is not set.\n"
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
  console.log(`\nreconciliation route test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");

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
  const tenantId1 = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId1,
    slug: "recon-t1",
    name: "Recon Tenant 1",
  });
  
  const tenantId2 = createId();
  await adminDb.insert(schema.organization).values({
    id: tenantId2,
    slug: "recon-t2",
    name: "Recon Tenant 2",
  });

  const staffUserId = createId();
  await adminDb.insert(schema.user).values({
    id: staffUserId,
    email: "staff@recon.test",
    name: "Staff",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A second staff user for the CLOSED shift below. This test's own DDL
  // generator (tableDdl/uniqueIndexDdls, copied from other module tests)
  // does not emit the WHERE clause on chrono_shift_one_open_per_staff_idx,
  // so it enforces uniqueness on (tenantId, branchId, staffUserId) across
  // ALL statuses in this harness — not just "open" as the real migration
  // does. Using a distinct staff user avoids a false collision between the
  // seeded open and closed shift; it does not affect what's under test
  // (the reconciliation route reads by shift id, not by staff).
  const closedShiftStaffUserId = createId();
  await adminDb.insert(schema.user).values({
    id: closedShiftStaffUserId,
    email: "closed-shift-staff@recon.test",
    name: "Closed Shift Staff",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await adminDb.insert(schema.tenantMember).values({
    id: createId(),
    tenantId: tenantId1,
    name: "Staff",
    email: "staff@recon.test",
    passwordHash: "none",
  });
  await adminDb.insert(schema.tenantMember).values({
    id: createId(),
    tenantId: tenantId2,
    name: "Staff",
    email: "staff@recon.test",
    passwordHash: "none",
  });

  const { chronoBranch } = await import("../branch/schema");
  const branchId = createId();
  await withTenant(tenantId1, (tx) =>
    tx.insert(chronoBranch).values({
      id: branchId,
      tenantId: tenantId1,
      name: "Branch 1",
      code: "B1",
    })
  );

  const { chronoProduct } = await import("../pos/schema");
  const productId = createId();
  await withTenant(tenantId1, (tx) => 
    tx.insert(chronoProduct).values([
      { id: productId, tenantId: tenantId1, name: "Product A", sku: "SKUA", category: "snack", price: "10.00" },
    ])
  );

  const { chronoShift } = await import("../shift/schema");
  const openShiftId = createId();
  await withTenant(tenantId1, (tx) => 
    tx.insert(chronoShift).values({
      id: openShiftId,
      tenantId: tenantId1,
      branchId,
      staffUserId,
      status: "open",
      openingCashAmount: "50.00",
    })
  );

  const closedShiftId = createId();
  await withTenant(tenantId1, (tx) => 
    tx.insert(chronoShift).values({
      id: closedShiftId,
      tenantId: tenantId1,
      branchId,
      staffUserId: closedShiftStaffUserId,
      status: "closed",
      openingCashAmount: "50.00",
      expectedCashAmount: "100.00",
      actualCashAmount: "95.00",
      differenceAmount: "-5.00",
      closedAt: new Date(),
    })
  );

  const t2ShiftId = createId();
  await withTenant(tenantId2, (tx) => 
    tx.insert(chronoShift).values({
      id: t2ShiftId,
      tenantId: tenantId2,
      branchId: createId(),
      staffUserId,
      status: "open",
      openingCashAmount: "50.00",
    })
  );

  // Setup pos checkouts to create some transactions
  const { checkout } = await import("../pos/service");
  await withTenant(tenantId1, async (tx) => {
    // 1 completed cash sale for open shift
    await checkout(tx, {
      tenantId: tenantId1, branchId, cashierUserId: staffUserId, input: {
        branchId,
        idempotencyKey: createId(),
        items: [{ productId, quantity: 2 }],
        payments: [{ method: "cash", amount: "20.00" }]
      }
    });
  });

  // Construct a minimal Hono app representing the module, mocking tenant middleware
  const app = new Hono<{ Variables: TenantVars }>();
  app.use("*", async (c, next) => {
    // Basic mock of tenant middleware logic
    c.set("tenant", {
      tenantId: c.req.header("x-tenant-id") ?? "",
      tenantSlug: "reconciliation-test",
      userId: staffUserId,
      role: "staff",
      status: "active",
      permissions: {
        reconciliation: ["read"],
      },
      impersonation: null,
    });
    await next();
  });
  app.route("/reconciliation", reconciliationRoutes());
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  });


  // Case 1: Open shift -> returns live preview (expectedCashAmount is computed, actual/difference are null)
  const reqOpen = new Request(`http://localhost/reconciliation/shifts/${openShiftId}`, {
    headers: { "x-tenant-id": tenantId1 }
  });
  const resOpen = await app.fetch(reqOpen);
  check("Open shift returns 200", resOpen.status === 200, `status = ${resOpen.status}`);
  const openBody = (await resOpen.json()) as ShiftReconciliationResponse;
  check("Open shift actualCashAmount is null", openBody.summary.actualCashAmount === null, `actualCashAmount = ${openBody.summary.actualCashAmount}`);
  check("Open shift differenceAmount is null", openBody.summary.differenceAmount === null, `differenceAmount = ${openBody.summary.differenceAmount}`);
  // expected is 50 opening + 20 sale = 70.00
  check("Open shift expectedCashAmount is computed live (70.00)", openBody.summary.expectedCashAmount === "70.00", `expectedCashAmount = ${openBody.summary.expectedCashAmount}`);

  // Case 2: Closed shift -> returns persisted immutable figures
  const reqClosed = new Request(`http://localhost/reconciliation/shifts/${closedShiftId}`, {
    headers: { "x-tenant-id": tenantId1 }
  });
  const resClosed = await app.fetch(reqClosed);
  check("Closed shift returns 200", resClosed.status === 200, `status = ${resClosed.status}`);
  const closedBody = (await resClosed.json()) as ShiftReconciliationResponse;
  check("Closed shift expectedCashAmount is persisted (100.00)", closedBody.summary.expectedCashAmount === "100.00", `expectedCashAmount = ${closedBody.summary.expectedCashAmount}`);
  check("Closed shift actualCashAmount is persisted (95.00)", closedBody.summary.actualCashAmount === "95.00", `actualCashAmount = ${closedBody.summary.actualCashAmount}`);
  check("Closed shift differenceAmount is persisted (-5.00)", closedBody.summary.differenceAmount === "-5.00", `differenceAmount = ${closedBody.summary.differenceAmount}`);

  // Case 3: Cross-tenant 404
  const reqCross = new Request(`http://localhost/reconciliation/shifts/${t2ShiftId}`, {
    headers: { "x-tenant-id": tenantId1 } // requesting t2's shift using t1
  });
  const resCross = await app.fetch(reqCross);
  check("Cross-tenant shift returns 404", resCross.status === 404, `status = ${resCross.status}`);

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
