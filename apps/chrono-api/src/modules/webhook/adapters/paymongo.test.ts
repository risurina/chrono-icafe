process.env.DB_DRIVER = "pglite";
process.env.APP_DOMAIN = "localtest.me:3000";
process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
process.env.WEB_ORIGIN = "http://localtest.me:3000";
process.env.NODE_ENV = "test";
process.env.DOMAIN_PROVIDER = "noop";
process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
process.env.STORAGE_PROVIDER = "local";
process.env.SSO_ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { createHmac, createHash } from "node:crypto";

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
  const { pool } = (await import("agora/db")) as any;
  const { eq } = await import("agora/db");

  const { chronoWebhookEvent } = await import("../schema");
  const { createWebhookProviderRegistry } = await import("../registry");
  const { HttpError } = await import("agora/server");
  const { withAdmin } = (await import("agora/db")) as any;
  const { encryptSecret } = await import("agora/server");
  
  const appSchema = await import("../../../db/schema");
  const { tenantIntegration, organization, tenantMember } = appSchema;
  const { chronoPayment } = await import("../../payment/schema");

  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];
  console.log("  creating pglite schema…");
  for (const t of tables) await pool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);

  // Expose the adapter to test
  const { paymongoWebhookAdapter } = await import("./paymongo");

  // Private registry & routes exactly like webhook.test.ts, but we also include dispatch
  const registry = createWebhookProviderRegistry();
  registry.register("paymongo", paymongoWebhookAdapter);

  const app = new Hono().post("/:provider", async (c) => {
    const providerId = c.req.param("provider");
    const adapter = registry.get(providerId);
    if (!adapter) throw new HttpError(404, "Unknown webhook provider.");

    const raw = await c.req.text();
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    const event = { raw, headers };

    await adapter.verifySignature(event);
    const parsed = adapter.parseEvent(event);
    const resolved = await adapter.resolve(parsed);
    const canonical = adapter.normalize(parsed, resolved);

    const payloadHash = createHash("sha256").update(raw).digest("hex");

    const inserted = await withAdmin((tx: any) =>
      tx
        .insert(chronoWebhookEvent)
        .values({
          provider: canonical.provider,
          providerEventId: canonical.providerEventId,
          providerAccountId: canonical.providerAccountId,
          scope: canonical.scope,
          tenantId: canonical.tenantId,
          integrationId: canonical.integrationId,
          eventType: canonical.eventType,
          resourceType: canonical.resourceType,
          resourceId: canonical.resourceId,
          signatureVerified: true,
          processingStatus: canonical.scope === "unresolved" ? "needs_resolution" : "received",
          payloadHash,
        })
        .onConflictDoNothing({
          target: [chronoWebhookEvent.provider, chronoWebhookEvent.providerEventId],
        })
        .returning({ id: chronoWebhookEvent.id })
    );

    if (inserted.length === 0) {
      return c.json({ received: true, deduped: true });
    }

    if (adapter.dispatch) {
      await adapter.dispatch(canonical);
    }
    return c.json({ received: true });
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  });

  function sign(ts: number, body: string, secret: string): string {
    return createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
  }

  function createFixture(tenantId: string | null, intentId: string, eventId: string) {
    return JSON.stringify({
      data: {
        id: eventId,
        type: "event",
        attributes: {
          type: "checkout_session.payment.paid",
          created_at: Math.floor(Date.now() / 1000),
          data: {
            id: "cs_123",
            attributes: {
              metadata: { tenantId, referenceId: intentId },
              line_items: [{ amount: 50000, currency: "PHP" }],
              payments: [
                {
                  attributes: {
                    amount: 50000,
                    currency: "PHP",
                    source: { type: "card", brand: "visa", last4: "4242" },
                  },
                },
              ],
            },
          },
        },
      },
    });
  }

  // Setup DB state
  const acmeId = "org_acme";
  const memberId = "mem_1";
  const intentId = "pmt_1";
  const secretKey = "whsec_acme_test";
  const secretEnc = encryptSecret(secretKey);

  process.env.PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET = "whsec_platform_test";

  await withAdmin(async (tx: any) => {
    await tx.insert(organization).values({ id: acmeId, name: "Acme", slug: "acme" });
    await tx.insert(tenantMember).values({ id: memberId, tenantId: acmeId, email: "user@acme.test", name: "User 1" });
    await tx.insert(tenantIntegration).values({
      tenantId: acmeId,
      category: "customerPayment",
      provider: "paymongo",
      enabled: true,
      config: { webhookSecretEnc: secretEnc },
    });
    await tx.insert(chronoPayment).values({
      id: intentId,
      tenantId: acmeId,
      memberId,
      amount: "500.00",
      currency: "PHP",
      method: "card",
      status: "pending",
      purpose: "wallet_topup",
    });
  });

  // 1. Tenant match
  {
    const body = createFixture(acmeId, intentId, "evt_1");
    const ts = Math.floor(Date.now() / 1000);
    const signature = `t=${ts},te=${sign(ts, body, secretKey)}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "paymongo-signature": signature }
    }));
    check("Tenant match 200", res.status === 200, await res.text());
    
    // Check webhook row
    const [whRow] = await withAdmin((tx: any) => tx.select().from(chronoWebhookEvent).where(eq(chronoWebhookEvent.providerEventId, "evt_1")));
    check("Tenant match webhook row scope=tenant", whRow?.scope === "tenant");
    check("Tenant match webhook row tenantId=acmeId", whRow?.tenantId === acmeId);

    // Check payment row fulfilled
    const [pmtRow] = await withAdmin((tx: any) => tx.select().from(chronoPayment).where(eq(chronoPayment.id, intentId)));
    check("Payment marked paid", pmtRow?.status === "paid");
  }

  // 2. Duplicate deduped
  {
    const body = createFixture(acmeId, intentId, "evt_1");
    const ts = Math.floor(Date.now() / 1000);
    const signature = `t=${ts},te=${sign(ts, body, secretKey)}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "paymongo-signature": signature }
    }));
    const text = await res.json() as any;
    check("Dedup match 200 with deduped: true", res.status === 200 && text.deduped === true);
  }

  // 3. Platform match
  {
    // Need a separate intent, since intent 1 is paid
    const platformIntent = "pmt_2";
    await withAdmin(async (tx: any) => {
      await tx.insert(chronoPayment).values({
        id: platformIntent,
        tenantId: acmeId,
        memberId,
        amount: "500.00",
        currency: "PHP",
        method: "card",
        status: "pending",
        purpose: "wallet_topup",
      });
    });
    
    // Since getCustomerPaymentFulfilment is part of bootstrap, we mock its registry
    // But actually, we need to register chrono_payment
    const { registerCustomerPaymentFulfilment } = await import("agora/customer-payments");
    const { fulfilCustomerPayment } = await import("../../payment/fulfilment");
    registerCustomerPaymentFulfilment("chrono_payment", async (tx: any, args: any) => {
      const result = await fulfilCustomerPayment(tx, args);
      if (result.outcome === "fulfilled" || result.outcome === "already_paid") {
        return { applied: true };
      }
      return { applied: false, reason: result.outcome };
    });

    // We use a fixture that has no tenantId in metadata? Wait, the plan says:
    // "The same event signed with the platform fallback secret and no tenant metadata (or metadata for a tenant with no enabled PayMongo integration) -> scope: platform"
    // Wait, let's just sign it with the platform secret. The adapter will verify it against the platform secret.
    const platformBody = createFixture(acmeId, platformIntent, "evt_2"); // it HAS metadata.tenantId, which is fine, platform fallback route handles it based on scope!
    const platformTs = Math.floor(Date.now() / 1000);
    const platformSignature = `t=${platformTs},te=${sign(platformTs, platformBody, "whsec_platform_test")}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body: platformBody,
      headers: { "Content-Type": "application/json", "paymongo-signature": platformSignature }
    }));
    check("Platform match 200", res.status === 200, await res.text());
    
    const [whRow] = await withAdmin((tx: any) => tx.select().from(chronoWebhookEvent).where(eq(chronoWebhookEvent.providerEventId, "evt_2")));
    check("Platform match webhook row scope=platform", whRow?.scope === "platform");
    check("Platform match webhook row tenantId=null", whRow?.tenantId === null);
    
    // Check payment row fulfilled
    const [pmtRow] = await withAdmin((tx: any) => tx.select().from(chronoPayment).where(eq(chronoPayment.id, platformIntent)));
    check("Platform match payment marked paid", pmtRow?.status === "paid");
  }

  // 4. Mismatched tenant metadata
  {
    const intent3 = "pmt_3";
    await withAdmin(async (tx: any) => {
      await tx.insert(chronoPayment).values({
        id: intent3,
        tenantId: acmeId,
        memberId,
        amount: "500.00",
        currency: "PHP",
        method: "card",
        status: "pending",
        purpose: "wallet_topup",
      });
    });

    // body claims tenantB, signed with tenantA secret
    const body = createFixture("org_other", intent3, "evt_3");
    const ts = Math.floor(Date.now() / 1000);
    const signature = `t=${ts},te=${sign(ts, body, secretKey)}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "paymongo-signature": signature }
    }));
    
    check("Mismatched metadata match 200", res.status === 200, await res.text());
    const [whRow] = await withAdmin((tx: any) => tx.select().from(chronoWebhookEvent).where(eq(chronoWebhookEvent.providerEventId, "evt_3")));
    check("Mismatched metadata scope=tenant", whRow?.scope === "tenant");
    check("Mismatched metadata tenantId=A (acmeId)", whRow?.tenantId === acmeId);
  }

  // 5. Invalid signature
  {
    const body = createFixture(acmeId, "pmt_x", "evt_4");
    const ts = Math.floor(Date.now() / 1000);
    const signature = `t=${ts},te=${sign(ts, body, "whsec_wrong")}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "paymongo-signature": signature }
    }));
    check("Invalid signature 400", res.status === 400);
  }

  // 6. Malformed JSON
  {
    const body = "{ invalid json";
    const ts = Math.floor(Date.now() / 1000);
    const signature = `t=${ts},te=${sign(ts, body, secretKey)}`;
    const res = await app.request(new Request("http://localhost/paymongo", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "paymongo-signature": signature }
    }));
    check("Malformed JSON 400", res.status === 400);
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
