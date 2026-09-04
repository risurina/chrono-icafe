/**
 * Payment portal-routes test (member-credit-purchase plan, Phase C4's own
 * required deliverable) — mirrors `modules/qr/routes.test.ts`'s scaffold:
 * resets and re-migrates a dedicated *test*-named database, seeds two real
 * tenants + tenantMembers, then drives the real HTTP surface
 * (`paymentPortalRoutes()`) via `app.fetch`, not mocks. The PSP call itself
 * is stubbed via `__setCustomerPaymentGateway` (the documented test seam) —
 * this proves the ROUTE wiring (auth gate, checkout row creation, narrowed
 * self-read, cross-tenant/cross-member isolation), not PayMongo's own HTTP
 * behavior (already unit-tested in `agora/customer-payments`'s own
 * `paymongo.test.ts`). The webhook's fulfilment logic is covered by
 * `fulfilment.test.ts`; this file does not re-drive the live webhook route
 * (which lives inline in `app.ts`, not a separate exported factory).
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
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
      "\npayment portal-routes test skipped: TEST_DATABASE_URL is not set.\n" +
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
  console.log(
    `\npayment portal-routes test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

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
  const { createId } = await import("agora");
  const { eq } = await import("agora/db");
  const { paymentPortalRoutes } = await import("./portal-routes");
  const { chronoPayment } = await import("./schema");
  const { Hono } = await import("hono");
  const { HttpError, __setCustomerPaymentGateway } = await import("agora/server");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  dropping all tables…");
  for (const t of tables) {
    await adminPool.query(`DROP TABLE IF EXISTS "${getTableConfig(t).name}" CASCADE;`);
  }
  console.log("  running migration (schema push)…");
  for (const t of tables) await adminPool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await adminPool.query(ddl);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`,
  );
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding two tenants…");

  async function seedTenant(slug: string) {
    const tenantId = createId();
    await adminDb.insert(schema.organization).values({ id: tenantId, slug, name: slug });
    const memberId = createId();
    const memberEmail = `customer@${slug}.test`;
    await withTenant(tenantId, (tx) =>
      tx.insert(schema.tenantMember).values({
        id: memberId,
        tenantId,
        email: memberEmail,
        name: "Test Customer",
        passwordHash: "unused-in-this-test",
      }),
    );
    const memberToken = `member-session-${createId()}`;
    await withTenant(tenantId, (tx) =>
      tx.insert(schema.tenantMemberSession).values({
        id: createId(),
        tenantId,
        memberId,
        tokenHash: createHash("sha256").update(memberToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    );
    return { tenantId, slug, memberId, memberToken };
  }

  const tenantA = await seedTenant("payment-route-test-a");
  const tenantB = await seedTenant("payment-route-test-b");

  // Stub the PSP: `createCheckout` returns a fake URL/ref, no network call.
  __setCustomerPaymentGateway(async () => ({
    id: "paymongo" as const,
    createCheckout: async () => ({ url: "https://paymongo.test/checkout/fake", providerRef: "cs_fake_123" }),
  }));

  const app = new Hono().route(
    "/portal/payments",
    paymentPortalRoutes({ tenantHostUrl: (slug, path) => `http://${slug}.localtest.me:3000${path}` }),
  );
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  async function call(
    path: string,
    opts: { method?: string; tenant?: { slug: string; memberToken: string }; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {};
    if (opts.body) headers["content-type"] = "application/json";
    if (opts.tenant) {
      headers["x-tenant-slug"] = opts.tenant.slug;
      headers["cookie"] = `agora_member=${opts.tenant.memberToken}`;
    }
    const res = await app.request(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as any };
  }

  console.log("\n1) Auth gate: anonymous is refused on every route.\n");
  // No `x-tenant-slug` at all -> resolveOrgFromRequest fails first (404,
  // "Unknown tenant") — a genuinely anonymous cross-origin caller. With a
  // resolvable tenant host but no session cookie, memberMiddleware's own
  // getMemberContext throws the real 401 ("Not authenticated") — that's the
  // gate this test is actually proving.
  const anonNoHost = await call("/portal/payments/gateway");
  check(
    "anonymous, no tenant host at all -> 404 (resolveOrgFromRequest fails first)",
    anonNoHost.status === 404,
    `got ${anonNoHost.status}`,
  );
  const anonGateway = await call("/portal/payments/gateway", {
    tenant: { slug: tenantA.slug, memberToken: "not-a-real-session-token" },
  });
  check(
    "resolvable host, invalid session -> 401 (not authenticated)",
    anonGateway.status === 401,
    `got ${anonGateway.status}`,
  );
  const anonCheckout = await call("/portal/payments/checkout", {
    method: "POST",
    tenant: { slug: tenantA.slug, memberToken: "not-a-real-session-token" },
    body: { purpose: "wallet_topup", amount: "50.00" },
  });
  check(
    "resolvable host, invalid session -> 401 on checkout too",
    anonCheckout.status === 401,
    `got ${anonCheckout.status}`,
  );

  console.log("\n2) Gateway status: unconfigured tenant reports unavailable, honestly.\n");
  const gatewayStatus = await call("/portal/payments/gateway", { tenant: tenantA });
  check(
    "gateway status: available is false with no integration row",
    gatewayStatus.body?.available === false,
    JSON.stringify(gatewayStatus.body),
  );

  console.log(
    "\n3) Checkout: with the PSP stubbed (agora/server's own __setCustomerPaymentGateway\n" +
      "   test seam — this overrides resolveCustomerPaymentGateway itself, so it stands in\n" +
      "   for a fully-configured tenant), a wallet_topup checkout creates a pending payment\n" +
      "   row and returns a checkout URL.\n",
  );
  const checkoutTopup = await call("/portal/payments/checkout", {
    method: "POST",
    tenant: tenantA,
    body: { purpose: "wallet_topup", amount: "50.00" },
  });
  check(
    "checkout: wallet_topup -> 201 with a paymentId and checkoutUrl",
    checkoutTopup.status === 201 && !!checkoutTopup.body?.paymentId && !!checkoutTopup.body?.checkoutUrl,
    JSON.stringify(checkoutTopup.body),
  );
  const [checkoutRow] = await withTenant(tenantA.tenantId, (tx) =>
    tx.select().from(chronoPayment).where(eq(chronoPayment.id, checkoutTopup.body.paymentId)),
  );
  check(
    "checkout: the created row is pending, purpose wallet_topup, amount matches the request",
    checkoutRow?.status === "pending" &&
      checkoutRow?.purpose === "wallet_topup" &&
      checkoutRow?.amount === "50.00",
    JSON.stringify(checkoutRow),
  );

  console.log("\n4) Contract validation: wallet_topup amount bounds are enforced.\n");
  const tooSmall = await call("/portal/payments/checkout", {
    method: "POST",
    tenant: tenantA,
    body: { purpose: "wallet_topup", amount: "5.00" },
  });
  check("checkout: below MIN_WALLET_TOPUP_AMOUNT is rejected (400)", tooSmall.status === 400);
  const productForTopup = await call("/portal/payments/checkout", {
    method: "POST",
    tenant: tenantA,
    body: { purpose: "credit_purchase", amount: "50.00" },
  });
  check(
    "checkout: amount is rejected on a credit_purchase request",
    productForTopup.status === 400,
  );

  console.log("\n5) A caller can only ever read their OWN payment; another member's 404s.\n");
  // Seed a payment row directly (bypassing checkout, which 400s without a
  // configured gateway) to exercise GET /:id in isolation.
  const [seededPayment] = await withTenant(tenantA.tenantId, (tx) =>
    tx
      .insert(chronoPayment)
      .values({
        id: createId(),
        tenantId: tenantA.tenantId,
        memberId: tenantA.memberId,
        amount: "300.00",
        currency: "PHP",
        method: "online",
        status: "pending",
        purpose: "wallet_topup",
      })
      .returning(),
  );

  const ownRead = await call(`/portal/payments/${seededPayment!.id}`, { tenant: tenantA });
  check("GET /:id: the owning member reads their own payment", ownRead.status === 200, JSON.stringify(ownRead.body));
  check(
    "GET /:id: the DTO is narrowed — no tenantId/memberId/providerReference leak",
    ownRead.body &&
      typeof ownRead.body === "object" &&
      !("tenantId" in ownRead.body) &&
      !("memberId" in ownRead.body) &&
      !("providerReference" in ownRead.body),
    JSON.stringify(ownRead.body),
  );

  // A second member of the SAME tenant must not read the first member's
  // payment (no existence leak — 404, not 403).
  const secondMemberId = createId();
  const secondMemberToken = `member-session-${createId()}`;
  await withTenant(tenantA.tenantId, (tx) =>
    tx.insert(schema.tenantMember).values({
      id: secondMemberId,
      tenantId: tenantA.tenantId,
      email: "second-member@payment-route-test-a.test",
      name: "Second Member",
      passwordHash: "unused-in-this-test",
    }),
  );
  await withTenant(tenantA.tenantId, (tx) =>
    tx.insert(schema.tenantMemberSession).values({
      id: createId(),
      tenantId: tenantA.tenantId,
      memberId: secondMemberId,
      tokenHash: createHash("sha256").update(secondMemberToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }),
  );
  const crossMemberRead = await call(`/portal/payments/${seededPayment!.id}`, {
    tenant: { slug: tenantA.slug, memberToken: secondMemberToken },
  });
  check(
    "GET /:id: a DIFFERENT member of the same tenant gets 404, not the row (no existence leak)",
    crossMemberRead.status === 404,
    `got ${crossMemberRead.status}`,
  );

  console.log("\n6) Cross-tenant isolation: tenant B can never see tenant A's payment.\n");
  const crossTenantRead = await call(`/portal/payments/${seededPayment!.id}`, { tenant: tenantB });
  check(
    "GET /:id: tenant B's member gets 404 for tenant A's payment id",
    crossTenantRead.status === 404,
    `got ${crossTenantRead.status}`,
  );

  __setCustomerPaymentGateway(null);
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
