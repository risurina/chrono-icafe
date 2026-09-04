/**
 * Fulfilment service tests for the member-credit-purchase plan, Phase C3
 * (`.ai/plans/chrono/active/member-credit-purchase/README.md`'s own required
 * deliverable). `fulfilCustomerPayment` is pure business logic over a
 * `TenantTx` — no HTTP, no webhook parsing, no PSP network call — so this
 * runs entirely against in-process PGlite (`DB_DRIVER=pglite`), mirroring
 * `modules/report/aggregation.test.ts`'s own "no TEST_DATABASE_URL required"
 * rationale: correctness here doesn't depend on real concurrent connections.
 *
 * Standalone tsx script (no unit-test runner in this repo).
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

function parsedPayment(over: Partial<{
  eventId: string;
  tenantId: string | null;
  referenceId: string | null;
  providerRef: string;
  amountMinorUnits: number;
  currency: string;
  status: "paid" | "failed";
  method: string | null;
  occurredAt: Date;
}>) {
  return {
    eventId: over.eventId ?? "evt_default",
    tenantId: over.tenantId ?? null,
    referenceId: over.referenceId ?? null,
    providerRef: over.providerRef ?? "ref_default",
    amountMinorUnits: over.amountMinorUnits ?? 0,
    currency: over.currency ?? "PHP",
    status: over.status ?? ("paid" as const),
    method: over.method ?? "gcash",
    occurredAt: over.occurredAt ?? new Date(),
  };
}

async function main() {
  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    (await import("agora/db")) as any;
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { createId } = await import("agora");
  const { eq } = await import("agora/db");

  const { chronoPayment } = await import("./schema");
  const { chronoCreditProduct, chronoCreditGrant, chronoCreditPurchase } = await import(
    "../credit/schema"
  );
  const { chronoWallet } = await import("../wallet/schema");
  const { creditWallet } = await import("../wallet/service");
  const { fulfilCustomerPayment } = await import("./fulfilment");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  creating pglite schema…");
  for (const t of tables) await pool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);
  await applyRls(pool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "fulfil-test", name: "Fulfilment Test" });
  const memberId = createId();
  await withTenant(tenantId, (tx: any) =>
    tx.insert(schema.tenantMember).values({
      id: memberId,
      tenantId,
      email: "member@fulfil-test.test",
      name: "Fulfilment Member",
      passwordHash: "unused",
    }),
  );

  async function seedPayment(over: Partial<{
    purpose: string | null;
    creditProductId: string | null;
    amount: string;
    currency: string;
    status: string;
  }>) {
    const [row] = await withTenant(tenantId, (tx: any) =>
      tx
        .insert(chronoPayment)
        .values({
          id: createId(),
          tenantId,
          memberId,
          amount: over.amount ?? "250.00",
          currency: over.currency ?? "PHP",
          method: "gcash",
          status: over.status ?? "pending",
          purpose: over.purpose ?? "wallet_topup",
          creditProductId: over.creditProductId ?? null,
        })
        .returning(),
    );
    return row;
  }

  async function walletBalance() {
    const [w] = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoWallet).where(eq(chronoWallet.memberId, memberId)),
    );
    return w?.balance ?? "0.00";
  }

  // ── Case 1: happy top-up ────────────────────────────────────────────
  {
    const payment = await seedPayment({ purpose: "wallet_topup", amount: "300.00" });
    const before = await walletBalance();
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 30000, currency: "PHP" }),
      }),
    );
    check("happy top-up: outcome is fulfilled", result.outcome === "fulfilled", JSON.stringify(result));
    const after = await walletBalance();
    check(
      "happy top-up: wallet credited by the exact amount",
      (Number(after) - Number(before)).toFixed(2) === "300.00",
      `before ${before}, after ${after}`,
    );
    const [row] = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoPayment).where(eq(chronoPayment.id, payment.id)),
    );
    check("happy top-up: payment row marked paid with fulfilledAt set", row.status === "paid" && row.fulfilledAt != null);
  }

  // ── Case 2: happy pack purchase ──────────────────────────────────────
  {
    const [product] = await withTenant(tenantId, (tx: any) =>
      tx
        .insert(chronoCreditProduct)
        .values({
          id: createId(),
          tenantId,
          name: "Happy Pack",
          code: "happy-pack",
          status: "active",
          quantityMinutes: 250,
          priceAmount: "250.00",
        })
        .returning(),
    );
    const payment = await seedPayment({
      purpose: "credit_purchase",
      creditProductId: product.id,
      amount: "250.00",
    });
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 25000, currency: "PHP" }),
      }),
    );
    check(
      "happy pack purchase: outcome is fulfilled, not degraded",
      result.outcome === "fulfilled" && !result.degraded,
      JSON.stringify(result),
    );
    const grants = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoCreditGrant).where(eq(chronoCreditGrant.memberId, memberId)),
    );
    check("happy pack purchase: exactly one grant issued", grants.length === 1, `got ${grants.length}`);
    const purchases = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoCreditPurchase).where(eq(chronoCreditPurchase.memberId, memberId)),
    );
    check(
      "happy pack purchase: the purchase row snapshots the payment's amount",
      purchases[0]?.priceAmount === "250.00",
      `got ${purchases[0]?.priceAmount}`,
    );
  }

  // ── Case 3: replay is a no-op ─────────────────────────────────────────
  {
    const payment = await seedPayment({ purpose: "wallet_topup", amount: "100.00", status: "paid" });
    const before = await walletBalance();
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 10000, currency: "PHP" }),
      }),
    );
    check("replay: outcome is already_paid", result.outcome === "already_paid", JSON.stringify(result));
    const after = await walletBalance();
    check("replay: wallet balance is unchanged", before === after, `before ${before}, after ${after}`);
  }

  // ── Case 4: amount mismatch voids and does not grant ─────────────────
  {
    const payment = await seedPayment({ purpose: "wallet_topup", amount: "500.00" });
    const before = await walletBalance();
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 10000, currency: "PHP" }), // 100.00, not 500.00
      }),
    );
    check("amount mismatch: outcome is amount_mismatch", result.outcome === "amount_mismatch", JSON.stringify(result));
    const after = await walletBalance();
    check("amount mismatch: wallet balance is unchanged", before === after, `before ${before}, after ${after}`);
    const [row] = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoPayment).where(eq(chronoPayment.id, payment.id)),
    );
    check(
      "amount mismatch: payment row is voided with a fulfilmentNote",
      row.status === "voided" && !!row.fulfilmentNote,
    );
  }

  // ── Case 5: currency mismatch voids ───────────────────────────────────
  {
    const payment = await seedPayment({ purpose: "wallet_topup", amount: "500.00", currency: "PHP" });
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 50000, currency: "USD" }),
      }),
    );
    check("currency mismatch: outcome is amount_mismatch", result.outcome === "amount_mismatch", JSON.stringify(result));
  }

  // ── Case 6: archived product degrades to a wallet credit and COMMITS ──
  {
    const [product] = await withTenant(tenantId, (tx: any) =>
      tx
        .insert(chronoCreditProduct)
        .values({
          id: createId(),
          tenantId,
          name: "Archived Pack",
          code: "archived-pack",
          status: "archived",
          quantityMinutes: 250,
          priceAmount: "250.00",
        })
        .returning(),
    );
    const payment = await seedPayment({
      purpose: "credit_purchase",
      creditProductId: product.id,
      amount: "250.00",
    });
    const before = await walletBalance();
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 25000, currency: "PHP" }),
      }),
    );
    check(
      "archived product: outcome is fulfilled AND degraded",
      result.outcome === "fulfilled" && result.degraded === true,
      JSON.stringify(result),
    );
    const after = await walletBalance();
    check(
      "archived product: wallet was still credited (degrades, does not roll back)",
      (Number(after) - Number(before)).toFixed(2) === "250.00",
      `before ${before}, after ${after}`,
    );
    const [row] = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoPayment).where(eq(chronoPayment.id, payment.id)),
    );
    check(
      "archived product: payment row is paid, with a fulfilmentNote explaining the degrade",
      row.status === "paid" && !!row.fulfilmentNote,
    );
  }

  // ── Case 7: an infrastructure error rethrows and rolls back ──────────
  {
    const [product] = await withTenant(tenantId, (tx: any) =>
      tx
        .insert(chronoCreditProduct)
        .values({
          id: createId(),
          tenantId,
          name: "Infra Error Pack",
          code: "infra-error-pack",
          status: "active",
          quantityMinutes: 250,
          priceAmount: "250.00",
        })
        .returning(),
    );
    const payment = await seedPayment({
      purpose: "credit_purchase",
      creditProductId: product.id,
      amount: "250.00",
    });
    const before = await walletBalance();

    const brokenPurchaseCreditProduct = async () => {
      throw new Error("simulated infrastructure failure (not an HttpError)");
    };

    let threw = false;
    try {
      await withTenant(tenantId, (tx: any) =>
        fulfilCustomerPayment(
          tx,
          {
            tenantId,
            parsed: parsedPayment({ referenceId: payment.id, amountMinorUnits: 25000, currency: "PHP" }),
          },
          { purchaseCreditProduct: brokenPurchaseCreditProduct as any, creditWallet },
        ),
      );
    } catch {
      threw = true;
    }
    check("infra error: fulfilCustomerPayment rethrows rather than swallowing it", threw);

    const after = await walletBalance();
    check(
      "infra error: the whole transaction rolled back — no wallet credit persisted",
      before === after,
      `before ${before}, after ${after}`,
    );
    const [row] = await withTenant(tenantId, (tx: any) =>
      tx.select().from(chronoPayment).where(eq(chronoPayment.id, payment.id)),
    );
    check(
      "infra error: the payment row is untouched (still pending)",
      row.status === "pending",
      `got ${row.status}`,
    );
  }

  // ── Case 8: a missing payment row is a no-op ──────────────────────────
  {
    const result = await withTenant(tenantId, (tx: any) =>
      fulfilCustomerPayment(tx, {
        tenantId,
        parsed: parsedPayment({ referenceId: "does-not-exist", amountMinorUnits: 100, currency: "PHP" }),
      }),
    );
    check("missing payment: outcome is missing", result.outcome === "missing", JSON.stringify(result));
  }

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
