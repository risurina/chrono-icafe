# Chrono Centralized Webhook Architecture

## Status

Phase 1 (Foundation) implemented and committed (`7d643923`). The Jules session
(2508701978338411204) that was fired for this phase reported `Failed` and its diff
deviated from the plan in several security-relevant ways (no idempotency constraint, no
signature-verification call, snake_case naming, wrong adapter interface, raw
headers/body persisted, superficial tests) — the diff was pulled for inspection, applied
to the working tree, and fixed locally by a fresh subagent to match this file's Phase 1
spec exactly before committing. See the ledger entry in `.ai/handover/jules-sessions.md`
for the full detail. Phases 2-5 are sketched (from the original architecture draft's
migration strategy) but each needs its own concreteness pass before it can be
claimed/implemented.

**Sessions:**
- Planning: current session
- Implementation: current session (Phase 1: Jules attempt failed/deviated, fixed and
  committed locally via a fresh subagent per delegate-implementation)

## Why

The developer wants one centralized, provider-agnostic inbound webhook subsystem for
Chrono so adding a new payment/messaging/identity provider never means a new
tenant-specific route or scattered provider-specific business logic. This is being built
**as originally designed** in the architecture draft (`/api/v1/webhooks/:provider`,
a dedicated `integrations`-shaped resolver, a canonical event model, `webhook_events`
persistence) — a deliberate choice to build the full mechanism rather than only closing
gaps in what already exists.

**Decided: every legacy webhook route is migrated onto the new architecture and then
deleted outright — not kept running alongside it, not an optional Phase 5 judgment
call.** There is no end state where two webhook systems coexist in this codebase.

**Important context found during planning** (so nobody rediscovers this mid-phase):
Chrono already has *some* centralized webhook infrastructure, built for narrower
purposes, all of which is in scope for migration-then-deletion by Phase 5:

- `POST /billing/webhook` (`apps/chrono-api/src/app.ts`) — platform-scope only,
  dispatches via `getBillingWebhookProvider(driver)` (`agora/billing`) across
  Stripe/PayMongo/Xendit for Chrono's own SaaS billing. No tenant resolution.
- `POST /payments/customer/webhook/platform` and `POST /payments/customer/webhook/:token`
  — the existing per-tenant and platform-fallback customer-payment webhooks, built on
  `packages/agora/src/commerce/customer-payments/` (a provider registry +
  fulfilment-registry seam that already implements the draft's §16/§19 asks, for the
  customer-payments case specifically).

Each route's existing verification/parsing/tenant-resolution/fulfilment logic gets
ported into a `WebhookProviderAdapter` on the new ingress (Phases 2-4), and the old
route + its now-dead code is deleted once traffic is proven to work on the new path
(Phase 5) — never left in place "just in case."

## Pass 1 — Workflow analysis

- **Who uses this**: nobody directly today (backend-only foundation). It exists to make
  the *next* Chrono payment/messaging provider integration cheap and safe, and to give
  ops a single place to trace "why did this webhook not apply."
- **Workflow enabled**: a new provider is added by writing one adapter + registering it
  — no new route, no new tenant URL, no branching added to `app.ts`.
- **Failure cases**: unknown provider → 404 before any DB work. Invalid signature → 400,
  never persisted as verified. Duplicate delivery → deduped via a DB unique constraint,
  not just an application-level check. Unparseable payload → 400. A body that parses but
  carries no derivable event id → 400. Tenant resolution genuinely impossible → persisted
  as `needs_resolution`, never guessed.
- **Audit**: none in Phase 1 (no financial state changes yet — this phase persists and
  acknowledges only). Audit wiring is a Phase 2 concern, once a real provider's
  processing actually mutates tenant state.

## Pass 2 — Technical research

### Module convention

`apps/chrono-api/src/modules/<domain>/` is mature (25 existing domains: `branch`,
`payment`, `wallet`, `business-lead`, etc.), each with `schema.ts` / `contracts.ts` /
`routes.ts` per `.ai/rules/business-app.md`. This plan adds a new domain, **`webhook`**
(kebab-case, singular noun, per `.ai/rules/monorepo.md` naming) —
`apps/chrono-api/src/modules/webhook/`. Do NOT use the original draft's illustrative
`integrations/webhook/ingress/adapters/...` nested tree (§18 of the original draft
explicitly says not to mechanically copy it when an established module convention
exists).

### Table shape and RLS scoping — platform-global, not RLS-scoped

The closest existing precedent for a table that must record BOTH platform-scope rows
(`tenantId: null`) and tenant-scope rows (`tenantId: <org>`), where the tenant isn't
always known at insert time, is `ChronoBusinessLeads`
(`apps/chrono-api/src/modules/business-lead/schema.ts`) and
`platformCollectedPayment` (`packages/agora/src/commerce/customer-payments/`): both are
**platform-global, NOT RLS-scoped, NOT in `APP_TENANT_TABLES`**, with `tenantId` as a
plain nullable FK reference used for grouping/filtering, not an isolation boundary. The
new `ChronoWebhookEvents` table follows the same shape — this is a deliberate,
precedented exception to "every tenant-referencing table is RLS-forced," justified
because an inbound webhook's tenant is sometimes unknown until the resolver runs
(`scope = unresolved`), which forced RLS cannot express (RLS needs a `tenant_id` set on
the connection *before* the row can even be written).

### Mount point — mirror `/api/v1/device`, not the existing `/api/v1` `apiV1` Hono chain

`apps/chrono-api/src/routes/api-v1.ts`'s `apiV1` Hono instance is tenant-authenticated
(applies `tenantMiddleware()` — every route under it needs a resolved tenant + API key).
An inbound provider webhook has neither. The working precedent for a real,
production, unauthenticated route living under the `/api/v1/*` path prefix without
going through `apiV1` is `/api/v1/device/*`
(`apps/chrono-api/src/app.ts:1179-1202`): `deviceAuthRoutes()`, `deviceRealtimeRoutes()`,
`appUsageDeviceRoutes()`, `deviceStatusRoutes()` are all `.route("/api/v1/device", ...)`
calls mounted directly on `app.ts`, **before** `.use("/api/v1/*", maintenanceReadOnlyGate)`
and `.route("/api/v1", apiV1)` (`app.ts:1247-1251`). The new webhook ingress follows
this exact pattern: `.route("/api/v1/webhooks", webhookIngressRoutes())`, mounted in the
same block, before the maintenance gate — a payment webhook must still land during
platform maintenance/read-only mode, exactly like `/billing/webhook` and
`/payments/customer/webhook/*` already do today (both mounted entirely outside
`/api/v1` for the same reason).

### Tenant/RLS impact

New table (`ChronoWebhookEvents`), but it is explicitly NOT added to `APP_TENANT_TABLES`
(see above) — so `rls:proof` does not need to (and cannot meaningfully) cover it, same
stance as `ChronoBusinessLeads`. `pnpm typecheck` is required. No existing RLS-scoped
table is touched in Phase 1.

## Phase 1 — Foundation (table, canonical event contract, adapter registry, generic ingress)

Builds the mechanism only. **No real provider is wired in this phase** — that is
Phase 2. Verified end-to-end using a test-only fake adapter registered inside the test
file, never exposed to the production registry.

### Files to Create

- `apps/chrono-api/src/modules/webhook/schema.ts`
- `apps/chrono-api/src/modules/webhook/contracts.ts`
- `apps/chrono-api/src/modules/webhook/registry.ts`
- `apps/chrono-api/src/modules/webhook/ingress.ts`
- `apps/chrono-api/src/modules/webhook/webhook.test.ts`

### Files to Update

- `apps/chrono-api/src/db/schema.ts` — export `chronoWebhookEvent` (composed alongside
  every other Chrono module table). Do NOT add it to `APP_TENANT_TABLES`.
- `apps/chrono-api/src/app.ts` — import `webhookIngressRoutes` from
  `./modules/webhook/ingress` and mount `.route("/api/v1/webhooks", webhookIngressRoutes())`
  in the same block as the existing `/api/v1/device` mounts (`app.ts:1179-1202`),
  before `.use("/api/v1/*", maintenanceReadOnlyGate)`.

### Step-by-Step Tasks

1. **`schema.ts`** — define `ChronoWebhookEvents` (Drizzle table name `"ChronoWebhookEvents"`,
   per business-app naming: business tables are app-prefixed):
   ```ts
   export const chronoWebhookEvent = pgTable("ChronoWebhookEvents", {
     id: text("id").primaryKey().$defaultFn(createId),
     provider: text("provider").notNull(),
     providerEventId: text("providerEventId").notNull(),
     providerAccountId: text("providerAccountId"),
     scope: text("scope", { enum: ["platform", "tenant", "unresolved"] }).notNull(),
     tenantId: text("tenantId").references(() => organization.id, { onDelete: "cascade" }),
     integrationId: text("integrationId"),
     eventType: text("eventType").notNull(),
     resourceType: text("resourceType"),
     resourceId: text("resourceId"),
     signatureVerified: boolean("signatureVerified").notNull().default(false),
     processingStatus: text("processingStatus", {
       enum: ["received", "processing", "processed", "failed", "needs_resolution", "ignored"],
     }).notNull().default("received"),
     attemptCount: integer("attemptCount").notNull().default(0),
     firstReceivedAt: timestamp("firstReceivedAt").notNull().defaultNow(),
     lastReceivedAt: timestamp("lastReceivedAt").notNull().defaultNow(),
     processedAt: timestamp("processedAt"),
     lastError: text("lastError"),
     payloadHash: text("payloadHash").notNull(),
     rawPayloadRef: text("rawPayloadRef"),
     createdAt: timestamp("createdAt").notNull().defaultNow(),
     updatedAt: timestamp("updatedAt").notNull().defaultNow(),
   }, (t) => ({
     providerEventUq: uniqueIndex("chrono_webhook_event_provider_event_uq")
       .on(t.provider, t.providerEventId),
     tenantIdx: index("chrono_webhook_event_tenant_idx").on(t.tenantId),
   }));
   ```
   `payloadHash` (sha256 of the raw body) exists for audit/debugging, NOT as the
   idempotency key — the unique constraint is `(provider, providerEventId)`, per the
   architecture's own §9 ("database uniqueness should enforce this, application-level
   checks alone are insufficient under concurrency"). Import `organization` from
   `agora/db/schema` and `createId` from `agora`, matching every other module.

2. **`contracts.ts`** — canonical event shape + provider adapter interface, as
   TypeScript types (not Zod — this is an internal server-side contract between the
   ingress and adapters, never crosses the wire to a client, so `.ai/rules/dto.md`'s
   "define wire shapes with Zod" doesn't apply here; it applies once a `/rpc` route
   exposes these events to the dashboard, which is out of scope for this phase):
   ```ts
   export interface ProviderWebhookEvent {
     raw: string;
     headers: Record<string, string | string[] | undefined>;
   }

   export interface CanonicalWebhookEvent {
     provider: string;
     providerEventId: string;
     providerAccountId: string | null;
     scope: "platform" | "tenant" | "unresolved";
     tenantId: string | null;
     integrationId: string | null;
     eventType: string;
     resourceType: string | null;
     resourceId: string | null;
   }

   export interface WebhookProviderAdapter {
     /** Throws on an invalid signature. Never trust the payload before this passes. */
     verifySignature(input: ProviderWebhookEvent): Promise<void>;
     /** Parse the raw body into a provider-shaped event. Throws on malformed JSON. */
     parseEvent(input: ProviderWebhookEvent): unknown;
     /**
      * Resolve scope/tenant/integration from the parsed event. Returns
      * scope: "unresolved" (never guesses) when it cannot determine ownership.
      */
     resolve(parsed: unknown): Promise<{
       scope: "platform" | "tenant" | "unresolved";
       tenantId: string | null;
       integrationId: string | null;
       providerAccountId: string | null;
     }>;
     /** Normalize into the canonical shape once scope/tenant are known. */
     normalize(
       parsed: unknown,
       resolved: { scope: "platform" | "tenant" | "unresolved"; tenantId: string | null; integrationId: string | null; providerAccountId: string | null },
     ): CanonicalWebhookEvent;
   }
   ```

3. **`registry.ts`** — a plain `Map`, not a growing switch statement (§19):
   ```ts
   const providers = new Map<string, WebhookProviderAdapter>();
   export function registerWebhookProvider(id: string, adapter: WebhookProviderAdapter) {
     if (providers.has(id)) throw new Error(`Webhook provider "${id}" is already registered.`);
     providers.set(id, adapter);
   }
   export function getWebhookProvider(id: string): WebhookProviderAdapter | null {
     return providers.get(id) ?? null;
   }
   ```
   No providers are registered by production code in this phase — the registry starts
   empty and `webhook.test.ts` registers a fake adapter for its own assertions only
   (register into a fresh `Map` instance constructed in the test, NOT the shared
   module-level singleton, so test registration can never leak into a real request).
   To make that possible, export a factory `createWebhookProviderRegistry()` returning
   `{ register, get }` bound to a private `Map`, and have `registry.ts`'s
   module-level exports be one instance of that factory (`export const {
   registerWebhookProvider, getWebhookProvider } = createWebhookProviderRegistry();`).
   The test imports the factory directly, not the shared instance.

4. **`ingress.ts`** — the thin controller, following the ingestion lifecycle (§8):
   ```ts
   export function webhookIngressRoutes() {
     return new Hono().post("/:provider", async (c) => {
       const providerId = c.req.param("provider");
       const adapter = getWebhookProvider(providerId);
       if (!adapter) throw new HttpError(404, "Unknown webhook provider.");

       const raw = await c.req.text();
       const headers = Object.fromEntries(c.req.raw.headers.entries());
       const event = { raw, headers };

       await adapter.verifySignature(event); // throws HttpError(400) on failure — adapter's job

       const parsed = adapter.parseEvent(event); // throws HttpError(400) on malformed body
       const resolved = await adapter.resolve(parsed);
       const canonical = adapter.normalize(parsed, resolved);

       const payloadHash = createHash("sha256").update(raw).digest("hex");

       const inserted = await withAdmin((tx) =>
         tx.insert(chronoWebhookEvent).values({
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
         .onConflictDoNothing({ target: [chronoWebhookEvent.provider, chronoWebhookEvent.providerEventId] })
         .returning({ id: chronoWebhookEvent.id }),
       );

       if (inserted.length === 0) {
         return c.json({ received: true, deduped: true });
       }
       // Phase 1 stops here: persisted + acknowledged. Async processing/dispatch to a
       // domain service is Phase 2+, once a real provider exists to dispatch for.
       return c.json({ received: true });
     });
   }
   ```
   `verifySignature`/`parseEvent` throwing `HttpError` (from `agora/server`) is the
   adapter's own responsibility, not the ingress's — keeps the ingress generic across
   adapters with different failure shapes, matching §4's "provider code should only
   understand provider-specific concepts."

5. **`webhook.test.ts`** — using this module's own registry factory
   (`createWebhookProviderRegistry()`), a hand-built Hono app mounting
   `webhookIngressRoutes()`-equivalent logic wired to the test's private registry
   instance (not the shared one), covering:
   - Unknown provider → 404, before any DB call.
   - Invalid signature (fake adapter throws) → 400, no row written.
   - Valid event → row written with `processingStatus: "received"`.
   - Same `(provider, providerEventId)` posted twice → second call returns
     `{ deduped: true }`, exactly one row exists in `ChronoWebhookEvents`.
   - Adapter resolving `scope: "unresolved"` → row written with
     `processingStatus: "needs_resolution"`, never guessed into a tenant.
   Use this app's existing test DB harness (the same one `business-lead`'s or
   `payment`'s own `*.test.ts` files use — inspect one for the exact setup helper
   before writing this file, since the plan should not invent a new one).

### Acceptance Criteria

- `ChronoWebhookEvents` exists, is exported from `db/schema.ts`, is NOT in
  `APP_TENANT_TABLES`.
- `POST /api/v1/webhooks/:provider` is reachable, mounted outside `/rpc` and outside
  the tenant-authenticated `apiV1` chain, unaffected by maintenance/read-only mode.
- An unknown `:provider` 404s before any DB work.
- A registered fake adapter proves the full lifecycle: verify → parse → resolve →
  normalize → persist → ack, including idempotent dedup on `(provider, providerEventId)`
  enforced by the DB unique index (not just an application check).
- An adapter that resolves `scope: "unresolved"` produces a `needs_resolution` row, not
  a guessed tenant.
- The production registry (`registry.ts`'s shared instance) starts empty — no adapters
  registered by this phase.
- `pnpm typecheck` passes.
- The new `webhook.test.ts` suite passes.

### Verification Commands

```
pnpm typecheck
pnpm --filter @agora/chrono-api test:webhook
```
(Add a `test:webhook` script to `apps/chrono-api/package.json` mirroring whatever
existing per-module test script convention is used, e.g. `test:billing-transactions`
in agora-api — inspect `apps/chrono-api/package.json` for the actual existing pattern
before naming this one.)

### Out of Scope (Phase 1)

- Wiring any real provider (PayMongo, Maya, Paddle) — Phase 2.
- Async/background processing, retries, dead-lettering (§21) — nothing in Phase 1
  triggers business-domain side effects yet, so there is nothing to retry.
- Migrating `/billing/webhook` or `/payments/customer/webhook/*` onto this mechanism —
  Phase 4/5.
- An admin UI for browsing `ChronoWebhookEvents` or resolving `needs_resolution` rows —
  not designed yet; flag as a likely Phase 6 need once real unresolved events exist.
- Any `/rpc` route exposing webhook events to the dashboard.

### Execution Start Point

Start with `contracts.ts` (no dependencies), then `schema.ts`, then `registry.ts`, then
`ingress.ts`, then wire it into `db/schema.ts` and `app.ts`, then `webhook.test.ts` last.

---

## Later phases (sketched — each needs its own concreteness pass before being claimed)

Carried over from the original architecture draft's migration strategy, adjusted for
what Phase 1 above actually builds:

### Phase 2 — First real provider (PayMongo)

Wire a real `WebhookProviderAdapter` for PayMongo, registered under `"paymongo"`,
covering BOTH flows the legacy routes currently split across two URLs: platform-fallback
(shared Chrono PayMongo account) and per-tenant (`tenant_integration` rows,
`provider = "paymongo"`). This adapter **supersedes**
`packages/agora/src/commerce/customer-payments/`'s existing PayMongo registry +
`platformCustomerPaymentWebhookRoutes()` — decided, not left open — so this phase's
concrete design must explicitly map: `tenant_integration` provider-account-id → tenant
lookup (§7.A) for the per-tenant case, and the existing Chrono-payment-reference
metadata path (§7.B) for the platform-fallback case, reusing
`fulfilCustomerPayment`/the fulfilment-registry seam as the dispatch target so business
logic isn't rewritten — only the ingress/verification/resolution layer moves.

### Phase 3 — Second provider

Migrate a second, genuinely different provider (Maya or Paddle) with zero changes to
the domain/payment architecture built in Phase 2 — the proof the architecture is
provider-independent.

### Phase 4 — Platform integrations

Move `/billing/webhook`'s Stripe/PayMongo/Xendit dispatch onto this same ingress.

### Phase 5 — Legacy route deletion (mandatory, not optional)

Delete `/billing/webhook`, `/payments/customer/webhook/platform`, and
`/payments/customer/webhook/:token` from `app.ts` entirely, along with any code that
existed only to serve them (e.g. `getBillingWebhookProvider` call sites specific to
these routes, `findTenantByCustomerPaymentWebhookToken` if nothing else uses it,
`platformCustomerPaymentWebhookRoutes()` if fully superseded). This only happens AFTER
Phase 4 proves the new ingress handles the same three flows correctly against real
provider traffic (Stripe/PayMongo/Xendit billing events, and PayMongo customer
checkout events, both platform-fallback and per-tenant). Update provider dashboards
(Stripe/Xendit/PayMongo webhook URL config) to point at the new
`/api/v1/webhooks/:provider` URLs as part of this phase — the external URL change is
itself a coordinated cutover step, not an afterthought.

## Acceptance criteria for the whole initiative (from the original draft, unchanged)

- One centralized inbound webhook subsystem in `chrono-api`.
- One stable webhook URL pattern per provider, not per tenant.
- Platform and tenant integrations use the same ingress architecture.
- Tenant resolution never trusts arbitrary tenant IDs from requests.
- Signature verification occurs before financial state changes.
- Duplicate provider events cannot duplicate financial effects.
- Provider payloads are normalized before reaching payment/business domains.
- Adding another provider does not require creating tenant-specific routes.
- Unresolved financial events are retained for manual resolution, never guessed.
