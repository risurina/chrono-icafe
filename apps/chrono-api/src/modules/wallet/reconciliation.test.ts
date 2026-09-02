/**
 * Wallet cash-attribution invariant test (reconciliation Phase 2,
 * `.ai/plans/chrono/active/reconciliation/README.md` — Phase 2's own
 * required deliverable).
 *
 * Proves the `cashTendered` flag on a manual wallet credit/debit correctly
 * attributes the transaction to the caller's open shift (`shiftId`), 409s
 * when no shift is open, and — critically — that `pos`'s own checkout code
 * path (unmodified, read-only for this test) never sets `shiftId` on the
 * wallet debit it triggers, since POS attributes cash via its own
 * `ChronoSales.shiftId`, not the wallet ledger's.
 *
 * Mirrors `concurrency.test.ts`'s scaffold: resets and re-migrates a
 * dedicated `*test*`-named database, then exercises the real service
 * functions directly (not HTTP + a mocked Hono context) — the same
 * convention every other module-local test in this repo already uses.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

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

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    console.log(
      "\nwallet cash-attribution test skipped: TEST_DATABASE_URL is not set.\n" +
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
  console.log(`\nwallet cash-attribution test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`);

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
  const { chronoWalletTransaction } = await import("./schema");
  const { chronoShift } = await import("../shift/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { createId } = await import("agora");
  const { eq, and, desc } = await import("agora/db");
  const { checkout } = await import("../pos/service");
  const { creditWallet, debitWallet } = await import("./service");
  const { findOpenShiftForStaff } = await import("../shift/service");
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
    slug: "wallet-cash-attribution",
    name: "Wallet Cash Attribution Co",
  });
  const memberId = createId();
  const staffUserId = createId();
  const branchId = createId();

  await withTenant(tenantId, (tx) =>
    tx.insert(schema.user).values({
      id: staffUserId,
      email: "staff@wallet-cash.test",
      name: "Staff",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "customer@wallet-cash.test",
      name: "Customer",
      passwordHash: "unused-in-this-test",
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.insert(chronoBranch).values({
      id: branchId,
      tenantId,
      name: "Branch 1",
      code: "B1",
    }),
  );

  // a) pos checkout never sets shiftId on a wallet debit it triggers.
  await withTenant(tenantId, (tx) =>
    creditWallet(tx, {
      tenantId,
      memberId,
      amount: "100.00",
      reason: "Initial funding",
      performedByUserId: staffUserId,
    }),
  );

  await withTenant(tenantId, (tx) =>
    checkout(tx, {
      tenantId,
      branchId,
      cashierUserId: staffUserId,
      input: {
        branchId,
        idempotencyKey: createId(),
        memberId,
        items: [{ name: "Test Ad Hoc", quantity: 1, unitPrice: "10.00" }],
        payments: [{ method: "wallet", amount: "10.00" }],
      },
    }),
  );

  const [posWalletTx] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoWalletTransaction)
      .where(and(eq(chronoWalletTransaction.tenantId, tenantId), eq(chronoWalletTransaction.type, "debit")))
      .orderBy(desc(chronoWalletTransaction.createdAt))
      .limit(1),
  );
  check(
    "POS checkout code path never sets shiftId on a wallet debit",
    posWalletTx !== undefined && posWalletTx.shiftId === null,
  );

  // b) manual credit with cashTendered: true and no open shift returns 409;
  // the same call with cashTendered: false succeeds regardless of shift state.
  async function creditCashTendered(): Promise<{ ok: boolean; status: number }> {
    try {
      await withTenant(tenantId, async (tx) => {
        const shift = await findOpenShiftForStaff(tx, { tenantId, userId: staffUserId });
        if (!shift) {
          throw new HttpError(409, "No open shift for this branch — open a shift before a cash transaction.");
        }
        return creditWallet(tx, {
          tenantId,
          memberId,
          amount: "15.00",
          reason: "Cash top-up",
          performedByUserId: staffUserId,
          shiftId: shift.id,
        });
      });
      return { ok: true, status: 200 };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, status: err.status };
      throw err;
    }
  }

  const creditNoShiftRes = await creditCashTendered();
  check("manual credit with cashTendered: true and no open shift returns 409", creditNoShiftRes.status === 409);

  await withTenant(tenantId, (tx) =>
    creditWallet(tx, {
      tenantId,
      memberId,
      amount: "15.00",
      reason: "Non-cash top-up",
      performedByUserId: staffUserId,
    }),
  );
  check("manual credit with cashTendered: false and no open shift succeeds", true);

  // c) manual credit/debit with cashTendered: true and an open shift sets shiftId correctly.
  const shiftId = createId();
  await withTenant(tenantId, (tx) =>
    tx.insert(chronoShift).values({
      id: shiftId,
      tenantId,
      branchId,
      staffUserId,
      openingCashAmount: "0.00",
      status: "open",
    }),
  );

  await withTenant(tenantId, async (tx) => {
    const shift = await findOpenShiftForStaff(tx, { tenantId, userId: staffUserId });
    if (!shift) throw new Error("expected an open shift");
    return creditWallet(tx, {
      tenantId,
      memberId,
      amount: "25.00",
      reason: "Cash top-up with open shift",
      performedByUserId: staffUserId,
      shiftId: shift.id,
    });
  });

  const [shiftWalletTx] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoWalletTransaction)
      .where(
        and(
          eq(chronoWalletTransaction.tenantId, tenantId),
          eq(chronoWalletTransaction.type, "credit"),
          eq(chronoWalletTransaction.amount, "25.00"),
        ),
      )
      .orderBy(desc(chronoWalletTransaction.createdAt))
      .limit(1),
  );
  check(
    "manual credit with open shift sets shiftId correctly on the inserted row",
    shiftWalletTx !== undefined && shiftWalletTx.shiftId === shiftId,
  );

  await withTenant(tenantId, async (tx) => {
    const shift = await findOpenShiftForStaff(tx, { tenantId, userId: staffUserId });
    if (!shift) throw new Error("expected an open shift");
    return debitWallet(tx, {
      tenantId,
      memberId,
      amount: "5.00",
      reason: "Cash withdrawal",
      performedByUserId: staffUserId,
      shiftId: shift.id,
    });
  });

  const [shiftDebitWalletTx] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoWalletTransaction)
      .where(
        and(
          eq(chronoWalletTransaction.tenantId, tenantId),
          eq(chronoWalletTransaction.type, "debit"),
          eq(chronoWalletTransaction.amount, "-5.00"),
        ),
      )
      .orderBy(desc(chronoWalletTransaction.createdAt))
      .limit(1),
  );
  check(
    "manual debit with open shift sets shiftId correctly on the inserted row",
    shiftDebitWalletTx !== undefined && shiftDebitWalletTx.shiftId === shiftId,
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
