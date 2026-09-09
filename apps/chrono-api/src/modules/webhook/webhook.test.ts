/**
 * Webhook ingress tests for Phase 1
 * (`.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`).
 * Runs against in-process PGlite (`DB_DRIVER=pglite`), mirroring
 * `modules/payment/fulfilment.test.ts`'s own harness.
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
import { Hono } from "hono";

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
  const { eq, and } = await import("agora/db");

  const { chronoWebhookEvent } = await import("./schema");
  const { createWebhookProviderRegistry } = await import("./registry");
  const { HttpError } = await import("agora/server");
  const { withAdmin } = (await import("agora/db")) as any;
  type WebhookProviderAdapter = import("./contracts").WebhookProviderAdapter;

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  creating pglite schema…");
  for (const t of tables) await pool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);

  // The test constructs its OWN registry instance — never the shared
  // production singleton — so test registrations can never leak into a real
  // request.
  const registry = createWebhookProviderRegistry();

  // A test-local re-implementation of the ingress route, wired to the test's
  // private registry (mirrors `webhookIngressRoutes()` exactly, but importing
  // the shared production registry would defeat the isolation this test is
  // proving).
  function testIngressRoutes() {
    return new Hono().post("/:provider", async (c) => {
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

      const { createHash } = await import("node:crypto");
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
          .returning({ id: chronoWebhookEvent.id }),
      );

      if (inserted.length === 0) {
        return c.json({ received: true, deduped: true });
      }
      return c.json({ received: true });
    });
  }

  function makeFakeAdapter(over: Partial<WebhookProviderAdapter> = {}): WebhookProviderAdapter {
    return {
      verifySignature: async () => {},
      parseEvent: (input) => JSON.parse(input.raw),
      resolve: async () => ({
        scope: "platform",
        tenantId: null,
        integrationId: null,
        providerAccountId: null,
      }),
      normalize: (parsed: any, resolved) => ({
        provider: "fake",
        providerEventId: parsed.id,
        providerAccountId: resolved.providerAccountId,
        scope: resolved.scope,
        tenantId: resolved.tenantId,
        integrationId: resolved.integrationId,
        eventType: parsed.type ?? "unknown",
        resourceType: null,
        resourceId: null,
      }),
      ...over,
    };
  }

  const app = new Hono().route("/", testIngressRoutes());
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  });

  async function eventCount(provider: string, providerEventId: string): Promise<any[]> {
    const rows = await withAdmin((tx: any) =>
      tx
        .select()
        .from(chronoWebhookEvent)
        .where(
          and(eq(chronoWebhookEvent.provider, provider), eq(chronoWebhookEvent.providerEventId, providerEventId)),
        ),
    );
    return rows as any[];
  }

  // ── Case 1: unknown provider -> 404, no DB call ───────────────────────
  {
    const req = new Request("http://localhost/unknown-provider", {
      method: "POST",
      body: JSON.stringify({ id: "evt_unknown" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request(req);
    check("unknown provider: 404", res.status === 404, `status: ${res.status}`);
    const rows = await eventCount("unknown-provider", "evt_unknown");
    check("unknown provider: no row written", rows.length === 0);
  }

  // ── Case 2: verifySignature throws -> 400, no row written ─────────────
  {
    registry.register(
      "bad-sig",
      makeFakeAdapter({
        verifySignature: async () => {
          throw new HttpError(400, "Invalid signature.");
        },
      }),
    );
    const req = new Request("http://localhost/bad-sig", {
      method: "POST",
      body: JSON.stringify({ id: "evt_bad_sig", type: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request(req);
    check("invalid signature: 400", res.status === 400, `status: ${res.status}`);
    const rows = await eventCount("fake", "evt_bad_sig");
    check("invalid signature: no row written", rows.length === 0);
  }

  // ── Case 3: valid event -> row written with processingStatus "received" ──
  {
    registry.register("fake", makeFakeAdapter());
    const req = new Request("http://localhost/fake", {
      method: "POST",
      body: JSON.stringify({ id: "evt_valid_1", type: "payment.paid" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request(req);
    const body = (await res.json()) as any;
    check("valid event: 200, received: true", res.status === 200 && body.received === true, JSON.stringify(body));
    const rows = await eventCount("fake", "evt_valid_1");
    check("valid event: exactly one row written", rows.length === 1, `got ${rows.length}`);
    check(
      "valid event: processingStatus is 'received'",
      rows[0]?.processingStatus === "received",
      `got ${rows[0]?.processingStatus}`,
    );
  }

  // ── Case 4: duplicate (provider, providerEventId) -> deduped ──────────
  {
    const req = new Request("http://localhost/fake", {
      method: "POST",
      body: JSON.stringify({ id: "evt_valid_1", type: "payment.paid" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request(req);
    const body = (await res.json()) as any;
    check("duplicate delivery: deduped: true", body.deduped === true, JSON.stringify(body));
    const rows = await eventCount("fake", "evt_valid_1");
    check("duplicate delivery: still exactly one row", rows.length === 1, `got ${rows.length}`);
  }

  // ── Case 5: resolve() returns scope "unresolved" -> needs_resolution ──
  {
    registry.register(
      "unresolved",
      makeFakeAdapter({
        resolve: async () => ({
          scope: "unresolved",
          tenantId: null,
          integrationId: null,
          providerAccountId: null,
        }),
        normalize: (parsed: any, resolved) => ({
          provider: "unresolved",
          providerEventId: parsed.id,
          providerAccountId: resolved.providerAccountId,
          scope: resolved.scope,
          tenantId: resolved.tenantId,
          integrationId: resolved.integrationId,
          eventType: parsed.type ?? "unknown",
          resourceType: null,
          resourceId: null,
        }),
      }),
    );
    const req = new Request("http://localhost/unresolved", {
      method: "POST",
      body: JSON.stringify({ id: "evt_unresolved_1", type: "payment.paid" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request(req);
    check("unresolved scope: 200", res.status === 200, `status: ${res.status}`);
    const rows = await eventCount("unresolved", "evt_unresolved_1");
    check(
      "unresolved scope: row written with needs_resolution, never a guessed tenant",
      rows.length === 1 && rows[0].processingStatus === "needs_resolution" && rows[0].tenantId === null,
      JSON.stringify(rows[0]),
    );
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
