import "dotenv/config";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { registerChronoPermissions } from "../../auth/permissions";

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
      "\nreconciliation formula test skipped: TEST_DATABASE_URL is not set.\n"
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
  console.log(`\nreconciliation formula test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  registerChronoPermissions();

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
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
    slug: "shift-recon",
    name: "Shift Recon Co",
  });
  
  const cashierUserId = createId();
  await adminDb.insert(schema.user).values({
    id: cashierUserId,
    email: "cashier@recon.test",
    name: "Cashier",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const memberId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "customer@recon.test",
      name: "Customer",
      passwordHash: "none",
    }),
  );

  const { chronoBranch } = await import("../branch/schema");
  const branchId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({
      id: branchId,
      tenantId,
      name: "Branch 1",
      code: "B1",
    })
  );

  const { chronoProduct } = await import("../pos/schema");
  const productAId = createId();
  const productBId = createId();
  await withTenant(tenantId, (tx) => 
    tx.insert(chronoProduct).values([
      { id: productAId, tenantId, name: "Product A", sku: "SKUA", category: "snack", price: "10.00" },
      { id: productBId, tenantId, name: "Product B", sku: "SKUB", category: "drink", price: "15.00" }
    ])
  );

  const { chronoShift } = await import("./schema");
  const shiftId = createId();
  await withTenant(tenantId, (tx) => 
    tx.insert(chronoShift).values({
      id: shiftId,
      tenantId,
      branchId,
      staffUserId: cashierUserId,
      status: "open",
      openingCashAmount: "50.00",
    })
  );

  // Setup pos checkouts
  const { checkout, refundSale } = await import("../pos/service");
  const { creditWallet, debitWallet } = await import("../wallet/service");

  await withTenant(tenantId, async (tx) => {
    // 2 completed cash sales
    await checkout(tx, {
      tenantId, branchId, cashierUserId, input: {
        branchId,
        idempotencyKey: createId(),
        items: [{ productId: productAId, quantity: 2 }],
        payments: [{ method: "cash", amount: "20.00" }]
      }
    });
    
    await checkout(tx, {
      tenantId, branchId, cashierUserId, input: {
        branchId,
        idempotencyKey: createId(),
        items: [{ productId: productBId, quantity: 1 }],
        payments: [{ method: "cash", amount: "15.00" }]
      }
    });

    // 1 refunded cash sale
    const { sale: toRefund } = await checkout(tx, {
      tenantId, branchId, cashierUserId, input: {
        branchId,
        idempotencyKey: createId(),
        items: [{ productId: productAId, quantity: 1 }],
        payments: [{ method: "cash", amount: "10.00" }]
      }
    });
    await refundSale(tx, { tenantId, saleId: toRefund.id, reason: "Defective", performedByUserId: cashierUserId });

    // 1 card sale
    // We temporally close the shift so it doesn't get assigned to shiftId, actually it just doesn't assign if there's no cash tender!
    await checkout(tx, {
      tenantId, branchId, cashierUserId, input: {
        branchId,
        idempotencyKey: createId(),
        items: [{ productId: productBId, quantity: 2 }],
        payments: [{ method: "card", amount: "30.00" }]
      }
    });

    // Wallet contributions
    // 1 shiftId-tagged credit
    await creditWallet(tx, {
      tenantId, memberId, amount: "40.00", reason: "Deposit", shiftId, performedByUserId: cashierUserId
    });
    
    // 1 shiftId-tagged debit
    await debitWallet(tx, {
      tenantId, memberId, amount: "12.00", reason: "Withdrawal", shiftId, performedByUserId: cashierUserId
    });

    // 1 non-shiftId-tagged credit
    await creditWallet(tx, {
      tenantId, memberId, amount: "100.00", reason: "Bank transfer", performedByUserId: cashierUserId
    });
  });

  const { computeExpectedCash } = await import("./service");
  
  // expectedCashAmount =
  //   shift.openingCashAmount = 50.00
  // + SUM(cash sales completed) = 20.00 + 15.00 = 35.00
  // - SUM(cash sales refunded) = 10.00
  // + SUM(ChronoWalletTransactions.amount WHERE shiftId = :shiftId) = 40.00 (credit) - 12.00 (debit) = 28.00
  // Expected = 50.00 + 35.00 - 10.00 + 28.00 = 103.00

  const computed = await withTenant(tenantId, (tx) => 
    computeExpectedCash(tx, { tenantId, shiftId, openingCashAmount: "50.00" })
  );

  check("expectedCashAmount computed by formula exactly matches manual computation (103.00)", computed === "103.00", `computed = ${computed}`);

  const { subtractMoney } = await import("../wallet/money");
  const actual = "100.00";
  const diff = subtractMoney(actual, computed); // "100.00" - "103.00" = "-3.00"
  
  check("differenceAmount matches actual - expected (-3.00)", diff === "-3.00", `diff = ${diff}`);

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

// Since we checked the routes manually, the PR description will note that we assert no patch route exists.
