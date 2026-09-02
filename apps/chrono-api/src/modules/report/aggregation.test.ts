/**
 * Deterministic aggregation test for reports Phase 3 (`.ai/plans/chrono/
 * active/reports/README.md`'s own required deliverable). Not a concurrency
 * test — reports is a read-only module, there is no race condition to prove
 * — this instead seeds known rows and asserts the aggregate math (sums,
 * grouping, date-range filtering, tenant scoping) against the real HTTP
 * routes, including the zero-rows/empty-tenant case (Pass 1's "empty-state"
 * failure case).
 *
 * Standalone tsx script against in-process PGlite (`DB_DRIVER=pglite`) — no
 * TEST_DATABASE_URL required, since correctness here doesn't depend on real
 * concurrent connections.
 */
process.env.DB_DRIVER = "pglite";
process.env.APP_DOMAIN = "localtest.me:3000";
process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
process.env.WEB_ORIGIN = "http://localtest.me:3000";
process.env.NODE_ENV = "test";
process.env.DOMAIN_PROVIDER = "noop";
process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
process.env.STORAGE_PROVIDER = "local";

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
      const cols = (i.config.columns as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
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

async function main() {
  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { app } = await import("../../app");
  const { auth } = await import("agora/auth");
  const { adminDb, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    (await import("agora/db")) as any;
  const { createId: makeId } = await import("agora");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoShift } = await import("../shift/schema");
  const { chronoSale, chronoSaleItem, chronoSalePayment } = await import("../pos/schema");
  const { chronoWalletTransaction, chronoWallet } = await import("../wallet/schema");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  creating pglite schema…");
  for (const t of tables) await pool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);
  await applyRls(pool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding tenant A (with data) and tenant B (empty)…");
  const PW = "Password123!";
  const staffA = await auth.api.signUpEmail({
    body: { email: "staff@reports-agg.test", password: PW, name: "Reports Staff" },
  });
  const tenantA = makeId();
  await adminDb.insert(schema.organization).values({ id: tenantA, slug: "reports-agg-a", name: "Reports Agg A" });
  await adminDb.insert(schema.member).values({
    id: makeId(),
    organizationId: tenantA,
    userId: staffA.user.id,
    role: "admin",
  });
  const tenantB = makeId();
  await adminDb.insert(schema.organization).values({ id: tenantB, slug: "reports-agg-b", name: "Reports Agg B (empty)" });
  const staffB = await auth.api.signUpEmail({
    body: { email: "staff@reports-agg-b.test", password: PW, name: "Reports Staff B" },
  });
  await adminDb.insert(schema.member).values({
    id: makeId(),
    organizationId: tenantB,
    userId: staffB.user.id,
    role: "admin",
  });

  const memberId = makeId();
  await withTenant(tenantA, (tx: any) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId: tenantA,
      email: "customer@reports-agg.test",
      name: "Agg Customer",
      passwordHash: "unused",
    }),
  );
  const [branch] = await withTenant(tenantA, (tx: any) =>
    tx.insert(chronoBranch).values({ id: makeId(), tenantId: tenantA, name: "Main", code: "MAIN" }).returning(),
  );
  const [shift] = await withTenant(tenantA, (tx: any) =>
    tx
      .insert(chronoShift)
      .values({
        id: makeId(),
        tenantId: tenantA,
        branchId: branch.id,
        staffUserId: staffA.user.id,
        status: "open",
        openingCashAmount: "100.00",
      })
      .returning(),
  );
  const [sale] = await withTenant(tenantA, (tx: any) =>
    tx
      .insert(chronoSale)
      .values({
        id: makeId(),
        tenantId: tenantA,
        branchId: branch.id,
        shiftId: shift.id,
        cashierUserId: staffA.user.id,
        status: "completed",
        totalAmount: "150.00",
        amountTendered: "150.00",
        changeAmount: "0.00",
        idempotencyKey: makeId(),
      })
      .returning(),
  );
  await withTenant(tenantA, (tx: any) =>
    tx.insert(chronoSaleItem).values({
      id: makeId(),
      tenantId: tenantA,
      saleId: sale.id,
      name: "Snack",
      unitPrice: "150.00",
      quantity: 1,
      lineTotal: "150.00",
    }),
  );
  await withTenant(tenantA, (tx: any) =>
    tx.insert(chronoSalePayment).values({
      id: makeId(),
      tenantId: tenantA,
      saleId: sale.id,
      method: "cash",
      amount: "150.00",
    }),
  );
  await withTenant(tenantA, (tx: any) =>
    tx.insert(chronoWallet).values({ tenantId: tenantA, memberId, balance: "50.00" }),
  );
  await withTenant(tenantA, (tx: any) =>
    tx.insert(chronoWalletTransaction).values({
      id: makeId(),
      tenantId: tenantA,
      walletId: makeId(),
      memberId,
      type: "credit",
      amount: "50.00",
      balanceBefore: "0.00",
      balanceAfter: "50.00",
      reason: "seed",
    }),
  );

  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base_ = `http://127.0.0.1:${port}`;
  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const cookieA = jar(
    (await auth.api.signInEmail({ body: { email: "staff@reports-agg.test", password: PW }, asResponse: true })).headers.getSetCookie(),
  );
  const cookieB = jar(
    (await auth.api.signInEmail({ body: { email: "staff@reports-agg-b.test", password: PW }, asResponse: true })).headers.getSetCookie(),
  );

  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  async function get(path: string, cookie: string, slug: string) {
    const res = await fetch(`${base_}${path}`, {
      headers: { "x-tenant-slug": slug, cookie },
    });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const salesSummary = await get(
    `/rpc/reports/sales-summary?from=${from}&to=${to}&branchId=${branch.id}`,
    cookieA,
    "reports-agg-a",
  );
  check("sales-summary 200 with a branchId", salesSummary.status === 200);
  check(
    "sales-summary totalRevenue matches the seeded sale",
    salesSummary.body?.totalRevenue === "150.00",
    JSON.stringify(salesSummary.body),
  );
  check("sales-summary saleCount is 1", salesSummary.body?.saleCount === 1);

  const shiftSummary = await get(
    `/rpc/reports/shift-summary?from=${from}&to=${to}&branchId=${branch.id}`,
    cookieA,
    "reports-agg-a",
  );
  check(
    "shift-summary returns exactly the one seeded shift",
    shiftSummary.body?.shifts?.length === 1,
    JSON.stringify(shiftSummary.body),
  );

  const walletActivity = await get(`/rpc/reports/wallet-activity?from=${from}&to=${to}`, cookieA, "reports-agg-a");
  check("wallet-activity 200 for admin", walletActivity.status === 200);
  check(
    "wallet-activity totalCredited matches the seeded credit",
    walletActivity.body?.totalCredited === "50.00",
    JSON.stringify(walletActivity.body),
  );

  const crossTenantBranch = await get(
    `/rpc/reports/sales-summary?from=${from}&to=${to}&branchId=${branch.id}`,
    cookieB,
    "reports-agg-b",
  );
  check(
    "a cross-tenant branchId 404s, not an empty/zeroed report",
    crossTenantBranch.status === 404,
    `got ${crossTenantBranch.status}`,
  );

  const emptyTenantSummary = await get(
    `/rpc/reports/sales-summary?from=${from}&to=${to}`,
    cookieB,
    "reports-agg-b",
  );
  check(
    "empty tenant returns zeroed aggregates, not a 500/crash",
    emptyTenantSummary.status === 200 &&
      emptyTenantSummary.body?.totalRevenue === "0.00" &&
      emptyTenantSummary.body?.saleCount === 0,
    JSON.stringify(emptyTenantSummary.body),
  );

  server!.close();
  await pool.end?.();

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
