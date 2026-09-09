# Chrono Centralized Webhook Architecture

## Status

Phase 1 (Foundation) implemented and committed (`7d643923`). The Jules session
(2508701978338411204) that was fired for this phase reported `Failed` and its diff
deviated from the plan in several security-relevant ways (no idempotency constraint, no
signature-verification call, snake_case naming, wrong adapter interface, raw
headers/body persisted, superficial tests) — the diff was pulled for inspection, applied
to the working tree, and fixed locally by a fresh subagent to match this file's Phase 1
spec exactly before committing. See the ledger entry in `.ai/handover/jules-sessions.md`
for the full detail.

Phase 2 (PayMongo adapter) implemented and committed (`591534ca`). Jules session
15002365596214251384 completed successfully this time — the diff matched the plan's
decided design closely (brute-force candidate-secret verification, the `dispatch()`
seam threading the parsed event via a per-request `WeakMap` keyed off the canonical
event object) and needed no local fixes. Verified directly (not just trusting the
session's self-report): `pnpm --filter @agora/chrono-api typecheck` clean; the new
`test:webhook` script (Phase 1's `webhook.test.ts`, unregressed, 11/11) plus the new
`adapters/paymongo.test.ts` (14/14, covering tenant match + fulfilment, platform match +
fulfilment, dedup, metadata-is-not-load-bearing, invalid signature, malformed JSON); the
existing `test:payment-fulfilment` suite (19/19, proving the legacy fulfilment path is
undisturbed). `app.ts` and the legacy webhook routes are untouched, as scoped. Phases
3-5 remain sketched only.

Phase 3 (promote the webhook ingress mechanism to `packages/agora`) implemented and
committed (`2975f4f2` code, `ad0fc9b7` migration). Jules session 12927776704988416128
completed successfully — a clean rename/relocation matching the plan exactly (git
detected `contracts.ts`/`registry.ts`/`ingress.ts`/`webhook.test.ts` as renames).
Verified directly: workspace-wide `pnpm typecheck` clean (all 5 packages, including
the untouched `apps/agora-api` scaffold, proving the foundation change doesn't break
the other app); both relocated/adjacent test suites pass unregressed (11/11, 14/14).
Local-only steps (Jules has no DB/secrets) completed after pulling: generated
`0037_add-webhook-events.sql` (single `CREATE TABLE` + FK + 2 indexes, reviewed before
applying), `pnpm db:migrate` applied it, `pnpm --filter @agora/chrono-api rls:proof`
passes — `WebhookEvents` correctly absent from the RLS-enforced table list. Required
before Phase 5 (below) can wire foundation billing code onto this ingress without the
foundation depending on `apps/chrono-api`. The old Phase 3 ("second provider,"
Maya/Paddle) is deferred by developer decision — building either from scratch is a
bigger, more product-shaped task than an architecture proof warrants; the renumbered
Phase 5 proves genericity instead by reusing Xendit's already-real billing vendor code.

Phase 5 (migrate Stripe/Xendit/PayMongo billing onto the ingress) implemented and
committed (`0826a326`). Jules session 1419847206865583467 was fired fire-and-forget and
picked back up in a later session: pulled, a stray `patch.diff` leftover from Jules's own
internal patching mechanism was deleted (its content duplicated the already-applied
`commerce/billing/index.ts` re-export, confirmed identical first). Review against the
plan found three real issues, all fixed locally: a misleadingly-named `secretEnvVar`
parameter that actually receives the secret value (renamed to `secret`); the `dispatch()`
audit-logic block silently dropping the `status`/`plan` metadata fields on the
subscription created/updated branch that `app.ts`'s existing handler writes (restored
verbatim); and a genuine regression — the new file's top-level imports of the
`agora/server`/`agora/audit`/`agora/webhooks/inbound` barrels closed a fresh
module-load-time circular dependency back into `commerce/billing/index.ts` (via
`core/server/retention.ts`'s pre-existing `PLAN_IDS`/`entitlementsFor` import from that
same `index.ts`), crashing every real import of `agora/billing` with a `PLANS`
before-initialization `ReferenceError`. `test:billing-webhook` (PGlite-only, never
touches the real barrel) didn't catch this; `test:billing-transactions` did, which is
exactly why the plan required running it as a regression check. Fixed by importing
`HttpError`/`registerWebhookProvider` from their leaf modules directly instead of the
barrels, and deferring `./server`/`agora/audit` into dynamic imports inside `dispatch()`.
Verified after fixes: `pnpm typecheck` clean (5/5 packages), `test:billing-webhook`
11/11, `test:billing-transactions` 49/49. `app.ts`'s `/billing/webhook` route is
provably untouched (zero diff), as required. Phase 6 remains sketched only.

**Sessions:**
- Planning: current session
- Implementation: current session (Phase 1: Jules attempt failed/deviated, fixed and
  committed locally via a fresh subagent per delegate-implementation. Phase 2: Jules
  attempt succeeded as delegated, verified and committed directly. Phase 3: Jules
  attempt succeeded as delegated; code verified/committed, then the local-only
  migration + rls:proof steps completed directly. Phase 5: Jules attempt fired
  fire-and-forget, pulled in a later session; three real issues found and fixed locally
  (misnamed parameter, incomplete audit metadata, a genuine module-cycle regression),
  verified and committed).

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

**Status: Accepted.** Concreteness Gate passed; the tenant-secret-resolution and
post-persist dispatch design points are both resolved (see "Status" at the top of this
file). Delegated to Jules.

Wire a real `WebhookProviderAdapter` for PayMongo, registered under `"paymongo"` on the
production registry (`registry.ts`'s shared instance — this is the first thing that ever
populates it), covering BOTH flows the legacy routes currently split across two URLs:
platform-fallback (shared Chrono PayMongo account, `POST
/payments/customer/webhook/platform`) and per-tenant (`tenant_integration` rows,
`category: "customerPayment"`, `provider: "paymongo"`, `POST
/payments/customer/webhook/:token`). This adapter **supersedes**
`packages/agora/src/commerce/customer-payments/`'s existing PayMongo webhook path — but
per "Critical design conflict" below, the legacy routes are **not deleted or cut over to
this phase**; that stays Phase 5, after Phase 4. Phase 2 builds and proves the adapter;
provider dashboards keep pointing at the legacy URLs throughout.

#### Critical design conflict: tenant resolution needs the secret, but signature
verification needs to happen first

The architecture's own acceptance criterion is "signature verification occurs before
financial state changes" and Phase 1's adapter interface is `verifySignature(input) →
parseEvent(input) → resolve(parsed)` — verify first, resolve (tenant) second. But
PayMongo's webhook signing secret is **per-tenant** (each tenant's own PayMongo account
has its own secret; the platform-fallback account has a separate one) — you cannot HMAC-
verify a payload without already knowing *which* secret to check it against, and today
that's solved by the URL itself carrying the tenant (`/payments/customer/webhook/:token`
→ `findTenantByCustomerPaymentWebhookToken` resolves the tenant/secret from the URL,
before touching the body at all). The new architecture's whole point is **one stable URL
per provider, not per tenant** (`/api/v1/webhooks/paymongo`), which removes that
URL-based channel entirely.

**Decided (developer, explicit): try every candidate secret — never trust any unverified
field to pick one.** `verifySignature` never reads `metadata.tenantId` (or any other body
field) before the HMAC check. Instead it brute-force-checks the signature against every
currently-enabled candidate secret until one matches:

1. Load every candidate secret: all enabled `tenantIntegration` rows with
   `category: "customerPayment"`, `provider: "paymongo"` (via `withAdmin` — no session
   exists pre-verification, same stance as `findTenantByCustomerPaymentWebhookToken`
   today), decrypting each row's `config.webhookSecretEnc`; plus the platform fallback
   secret (`PLATFORM_CUSTOMER_PAYMENT_PAYMONGO_WEBHOOK_SECRET`, env), if configured.
2. For each candidate, verify the HMAC (`verifyPaymongoSignature`, reused as-is from
   `packages/agora/src/commerce/billing/vendors/paymongo.ts`) against the raw body +
   signature header. Stop at the first match. Track which candidate matched (tenant row
   id, or "platform") — this is the actual, verified identity, never a claim from the
   payload.
3. No candidate matches → `HttpError(400, "Invalid signature.")`. Never fall through to
   "unresolved" — an unverifiable signature is a hard reject, not a webhook worth
   persisting.
4. Malformed JSON at this stage is not this method's problem — `verifySignature` only
   needs the raw bytes and the header to compute/compare HMACs, never parses the body.
   `parseEvent` (next in the lifecycle) does the actual JSON parse and throws
   `HttpError(400)` on malformed input, per its own Phase-1 contract.
5. **Threading the winning candidate to `resolve()` without shared mutable adapter
   state**: adapters are registered once and reused across concurrent requests, so a
   mutable instance field would race. `resolve()` independently re-runs the same
   brute-force candidate search against the now-parsed event (deliberate double work,
   not an optimization target — it keeps `verifySignature` and `resolve` each
   independently correct with no shared state, and Phase 1's adapter interface has no
   return-value threading from `verifySignature` to later steps). Because the search is
   deterministic over the same candidate set and the same raw body, it re-derives the
   identical winner.
6. `resolve()`'s output: the winning candidate is a tenant row → `{scope: "tenant",
   tenantId, integrationId: <tenantIntegration.id>, providerAccountId: null}` (PayMongo
   surfaces no merchant-id field to us — `providerAccountId` stays `null`, per
   `.ai/rules/database.md`'s "nullable when genuinely unknown," not a placeholder). The
   winning candidate is the platform secret → `{scope: "platform", tenantId: null,
   integrationId: null, providerAccountId: null}`. `resolve()` never returns
   `"unresolved"` for PayMongo specifically — successful `verifySignature` already
   proves which account this event belongs to, so "unresolved" is unreachable on this
   path and is not asserted as a test case for the real adapter (it stays a
   Phase-1-only fake-adapter scenario).
7. **Known scaling limit, accepted for this phase**: this is O(N) HMAC checks per
   webhook delivery, where N is the number of tenants with an enabled PayMongo
   `customerPayment` integration. Fine at current scale; flagged here so a future phase
   can revisit (e.g. an index keyed by a secret fingerprint) if the tenant count with
   configured PayMongo integrations grows large enough for this to matter — not a
   problem to solve preemptively now.
8. **A `metadata.tenantId` value on the payload is informational only, never load-bearing
   for identity.** `parsePaymongoCustomerPayment` still reads it (unchanged, existing
   behavior) for the `ParsedCustomerPayment.tenantId` field the fulfilment path already
   consumes for its own re-check — but the webhook's tenant *scope* comes from
   `resolve()`'s verified candidate above, never from this field. A payload whose
   metadata claims tenant B but is signed with tenant A's real secret resolves to tenant
   A (see Acceptance Criteria).

#### Dedup: `ChronoWebhookEvents` gates the NEW route only

The legacy `chronoPaymentEvent` idempotency key (partial unique index on
`(tenantId, idempotencyKey)`) keeps gating the **legacy** `:token` route unchanged — this
phase does not touch `apps/chrono-api/src/app.ts`'s existing webhook handlers or
`chronoPaymentEvent`. The **new** `/api/v1/webhooks/paymongo` route's dedup is
`ChronoWebhookEvents`'s `(provider, providerEventId)` unique index from Phase 1,
unchanged. Because provider dashboards are not repointed until Phase 5, the new route
receives no live duplicate/replay traffic to reconcile against the legacy route in this
phase — both mechanisms coexist without double-processing risk simply because only one
of them is receiving real deliveries at any given time.

#### Fulfilment dispatch — reuse, do not rewrite

`normalize()` maps the verified PayMongo event into `CanonicalWebhookEvent`
(`eventType: "checkout_session.payment.paid"`, `resourceType: "customer_payment"`,
`resourceId: parsed.referenceId`). The ingress itself (`ingress.ts`, from Phase 1) stops
at persist+ack — Phase 1 explicitly deferred "async processing/dispatch to a domain
service" to Phase 2+. This phase adds that dispatch as a **second, explicit step inside
the PayMongo route path** (not a generic ingress feature — the ingress stays
provider-agnostic and un-opinionated about what happens after persistence, per §4's
"provider code should only understand provider-specific concepts"): after the
`ChronoWebhookEvents` row is inserted (not deduped), call `fulfilCustomerPayment` (tenant
scope) or the existing registry-based `getCustomerPaymentFulfilment("chrono_payment")`
path (platform scope, matching how the platform route already dispatches today) with the
same `ParsedCustomerPayment` shape the legacy verifier already produces — no change to
`fulfilCustomerPayment`'s signature or `FulfilmentOutcome` handling (amount-mismatch
audit, wallet-low publish, degraded-purchase note) is needed; this phase only changes
*how* a verified event reaches that function, never what it does with one.

**Decided: the dispatch seam is an optional `dispatch()` method added to Phase 1's
`WebhookProviderAdapter` interface** (`apps/chrono-api/src/modules/webhook/contracts.ts`),
not a PayMongo-specific route wrapper — this keeps `ingress.ts` provider-agnostic (it
calls whatever the registered adapter provides, never branches on provider id) while
letting each adapter own routing its own canonical events to its own domain, matching
the architecture's own "provider adapter → canonical event → domain service" direction
(never the reverse). Concretely:

```ts
// contracts.ts addition:
dispatch?(canonical: CanonicalWebhookEvent): Promise<void>;
```

`ingress.ts` (Phase 1, being extended here) calls `await adapter.dispatch?.(canonical)`
**synchronously, before responding** to the provider — immediately after a successful
non-deduped insert, still inside the same request. This deliberately does not implement
the architecture's idealized "ack first, process async" ordering (§21) — there is no
queue/worker infrastructure in this codebase yet, and the legacy routes this phase
supersedes already call `fulfilCustomerPayment` synchronously before responding, so this
keeps identical behavior to today rather than inventing new async infrastructure as a
side effect of this phase. A thrown error from `dispatch()` propagates as a normal
`HttpError`/500 — the row is already persisted (committed insert), so a provider retry
on failure re-delivers into the dedup gate rather than re-inserting, meaning a
dispatch-time failure is safely retryable by the provider's own webhook retry policy.
True async processing (queue-backed, ack-then-process) is an explicit future improvement,
not required by this phase's acceptance criteria.

For PayMongo specifically, `dispatch()` calls `fulfilCustomerPayment` (tenant scope, via
`withTenant`) or `getCustomerPaymentFulfilment("chrono_payment")` (platform scope,
matching how the platform route already dispatches today), branching on
`canonical.scope` — using the same `ParsedCustomerPayment` shape `parseEvent` already
produced (threaded through via a closure capture in the adapter module, not re-parsed).

### Files to Create (Phase 2)

- `apps/chrono-api/src/modules/webhook/adapters/paymongo.ts` — the
  `WebhookProviderAdapter` implementation described above.
- `apps/chrono-api/src/modules/webhook/adapters/paymongo.test.ts` — adapter-level tests
  (see Acceptance Criteria) using real PayMongo-shaped fixtures and real HMAC signing
  (compute a valid signature over a fixture body with a test secret, the same way
  `packages/agora/src/commerce/customer-payments/paymongo.test.ts` already does — inspect
  that file's fixture/signing helper and reuse it rather than inventing a second one).
- A registration bootstrap: extend `apps/chrono-api/src/payment-bootstrap.ts` (imported
  early in `src/index.ts`, already the home of the `registerCustomerPaymentFulfilment`
  call) to also call `registerWebhookProvider("paymongo", paymongoWebhookAdapter)` —
  keeps every startup-time registration in the one file already responsible for
  "register before traffic."

### Files to Update (Phase 2)

- `apps/chrono-api/src/payment-bootstrap.ts` — add the registration call above.
- `apps/chrono-api/src/modules/webhook/contracts.ts` — add the optional
  `dispatch?(canonical: CanonicalWebhookEvent): Promise<void>` method to
  `WebhookProviderAdapter` (see "Fulfilment dispatch" above).
- `apps/chrono-api/src/modules/webhook/ingress.ts` — after a successful non-deduped
  insert, call `await adapter.dispatch?.(canonical)` before responding, per the design
  above.
- None of `apps/chrono-api/src/app.ts`'s existing `/billing/webhook` or
  `/payments/customer/webhook/*` handlers change in this phase.

### Step-by-Step Tasks

1. Read `packages/agora/src/commerce/customer-payments/paymongo.test.ts` for the
   existing HMAC-fixture-signing test helper; reuse it in the new adapter test rather
   than reimplementing signature generation.
2. Write `adapters/paymongo.ts`: `verifySignature` (load every enabled tenant secret +
   platform secret → brute-force HMAC verify against each → first match wins, per the
   design above), `parseEvent` (delegates to the existing
   `parsePaymongoCustomerPayment`, throws `HttpError(400)` on `null`/malformed), `resolve`
   (tenant-row lookup + scope decision, per the design above), `normalize` (→
   `CanonicalWebhookEvent`).
3. Add the optional `dispatch?()` method to `WebhookProviderAdapter`
   (`contracts.ts`) and wire `ingress.ts` to call it post-insert, per the decided design
   above. Implement PayMongo's `dispatch()` to branch on `canonical.scope` and call
   `fulfilCustomerPayment` (tenant) or `getCustomerPaymentFulfilment("chrono_payment")`
   (platform).
4. Register the adapter in `payment-bootstrap.ts`.
5. Write `adapters/paymongo.test.ts` covering the Acceptance Criteria below.

### Acceptance Criteria

- A `checkout_session.payment.paid` event, correctly signed with a **tenant's**
  configured PayMongo webhook secret and carrying that tenant's id in metadata, posted to
  `/api/v1/webhooks/paymongo`, produces a `ChronoWebhookEvents` row with `scope:
  "tenant"`, `tenantId` set, `processingStatus: "received"`, AND results in the same
  `fulfilCustomerPayment` outcome (wallet credited / payment marked paid) the legacy
  `:token` route would produce for the equivalent payload.
- The same event signed with the **platform** fallback secret and no tenant metadata (or
  metadata for a tenant with no enabled PayMongo integration) → `scope: "platform"`,
  `tenantId: null`, and dispatches through the existing
  `getCustomerPaymentFulfilment("chrono_payment")` registry path.
- A payload signed with **tenant A's** real secret but whose `metadata.tenantId` claims
  tenant B (or is absent) → resolves to **tenant A** (`scope: "tenant"`, `tenantId` =
  A) — proves the payload's own metadata is never load-bearing for identity, only the
  verified signature is.
- A payload signed with a secret that matches **no** enabled tenant and **not** the
  platform secret → `HttpError(400)`, no `ChronoWebhookEvents` row, no fulfilment call.
- Replaying the identical signed payload twice → second call `{received: true, deduped:
  true}`, exactly one `ChronoWebhookEvents` row, fulfilment invoked exactly once (not
  twice) — proves the dedup gate sits before dispatch, not just before insert.
- Malformed JSON body (still correctly HMAC-signed over the garbage bytes, so signature
  verification alone can't catch it) → `HttpError(400)` from `parseEvent`, no row
  written.
- `pnpm typecheck` passes.
- The legacy `/payments/customer/webhook/:token` and `/payments/customer/webhook/platform`
  routes are provably untouched (no diff in `app.ts` beyond the Phase 1 mount already
  committed) and their own existing tests still pass unchanged.
- The production registry now has exactly one entry (`"paymongo"`) — verified by a test
  asserting `getWebhookProvider("paymongo")` is non-null and `getWebhookProvider("maya")`
  (or any other id) is still `null`.

### Verification Commands

```
pnpm typecheck
pnpm --filter @agora/chrono-api test:webhook
pnpm --filter @agora/chrono-api test:payment-fulfilment
```
(Re-run the existing payment-fulfilment/customer-payments test scripts specifically to
prove the legacy path is undisturbed — a regression there would mean this phase touched
shared code it shouldn't have.)

### Out of Scope (Phase 2)

- Deleting or modifying the legacy `/payments/customer/webhook/:token` and
  `/payments/customer/webhook/platform` routes, or `/billing/webhook` — Phase 4/5.
- Repointing PayMongo's dashboard webhook URL configuration to the new
  `/api/v1/webhooks/paymongo` endpoint — Phase 5, coordinated cutover only.
- A second provider (Maya/Paddle) — Phase 3.
- Any change to `fulfilCustomerPayment`'s signature, `FulfilmentOutcome` shape, or wallet-
  crediting logic.
- Any change to `chronoPaymentEvent`'s schema or the legacy route's own idempotency
  index.
- An admin UI surfacing the new table's rows.

### Execution Start Point

Start with `contracts.ts`'s `dispatch?()` addition (small, unblocks everything else),
then `adapters/paymongo.ts`'s `verifySignature`+`parseEvent` (portable from existing
code, lowest risk), then `resolve`, then `normalize`, then `dispatch`, then
`ingress.ts`'s post-insert call, then `payment-bootstrap.ts`, then
`adapters/paymongo.test.ts` last — mirroring Phase 1's "tests last, once the pieces they
exercise all exist" ordering.

### Phase 3 — Promote the webhook ingress to `packages/agora` (foundation)

**Status: Accepted** (developer, explicit — chose "promote first" over "stay
Chrono-local" when the conflict below was surfaced). Delegated to Jules for the
code-relocation portion; migration generation + `rls:proof` run locally (Jules's VM has
no DB/secrets).

**Why**: Phase 4 (next) needs to migrate `/billing/webhook`'s dispatch — which lives in
**foundation** code (`packages/agora/src/commerce/billing/`, shared by every business
app, not Chrono-specific) — onto this ingress. But the ingress itself
(`ChronoWebhookEvents`, the adapter contracts, the registry, `webhookIngressRoutes()`)
was built in Phases 1-2 entirely inside `apps/chrono-api/src/modules/webhook/`, a
Chrono-only location. Wiring foundation billing code onto a Chrono-app-local mechanism
would make shared foundation code depend on business-app infrastructure — backwards per
`.ai/rules/architecture.md`'s "if a second business app would need it too, it goes in
the foundation." This phase moves the mechanism (not PayMongo's adapter, which stays
Chrono-specific business logic) into `packages/agora`, mirroring how the OUTBOUND
webhook mechanism (`agora/webhooks` — `webhookEndpoint`/`webhookDelivery`,
`emit.ts`/`job.ts`/`routes.ts`) already lives in the foundation while its callers
(`emitTenantEvent(...)`) are sprinkled through business-app code.

**Confirmed foundation conventions this phase follows** (checked directly, not
assumed): `agora/webhooks`' own outbound tables are physically defined in
`packages/agora/src/core/db/schema/tenant.ts` (NOT co-located with the outbound
module's own `src/events/webhooks/*.ts` logic files) and re-exported through
`packages/agora/src/core/db/schema/index.ts`'s `export * from "./tenant"` — the
module's *logic* and its *Drizzle table definition* live in different, established
locations. Every app's own `db/schema.ts` re-exports the ENTIRE foundation schema via
`export const { ...tables } = base;` (`base = import * as base from "agora/db/schema"`)
so drizzle-kit (pointed at each app's own `db/schema.ts`) picks up foundation tables
too — this is how `apiKey`/`webhookEndpoint`/`tenantIntegration`/`billingEvent`/
`paymentTransaction` already reach `apps/chrono-api/drizzle/*.sql` today (confirmed:
`apps/chrono-api/src/db/schema.ts` lines 95-149, `export const { user, ..., billingEvent,
paymentTransaction, ..., tenantIntegration, ... } = base;`). `webhookEvent` (renamed from
`chronoWebhookEvent` — foundation tables are unprefixed) follows the exact same path:
physically defined in `packages/agora/src/core/db/schema/platform.ts` (it's
platform-global/non-RLS, same category as `platform_integration`), re-exported through
the barrel, then re-exported again from each app's own `db/schema.ts`.

**No existing migration to reconcile**: `ChronoWebhookEvents` was never migrated to a
real database (`grep -rl "ChronoWebhookEvents" apps/chrono-api/drizzle` returns
nothing) — Phases 1-2 only ever ran against PGlite in tests. So this phase generates
ONE fresh migration for the relocated, renamed table, not a rename-migration.

#### Files to Create

- `packages/agora/src/events/webhooks/inbound/contracts.ts` — moved verbatim from
  `apps/chrono-api/src/modules/webhook/contracts.ts` (no content changes — the types
  are already generic, no Chrono-specific naming).
- `packages/agora/src/events/webhooks/inbound/registry.ts` — moved verbatim from
  `apps/chrono-api/src/modules/webhook/registry.ts` (no content changes).
- `packages/agora/src/events/webhooks/inbound/ingress.ts` — moved from
  `apps/chrono-api/src/modules/webhook/ingress.ts`, with its `chronoWebhookEvent` import
  changed to `import { webhookEvent } from "agora/db/schema";` and every
  `chronoWebhookEvent` reference in the file renamed to `webhookEvent`.
- `packages/agora/src/events/webhooks/inbound/index.ts` — new barrel:
  ```ts
  export type {
    ProviderWebhookEvent,
    CanonicalWebhookEvent,
    ResolvedWebhookScope,
    WebhookProviderAdapter,
  } from "./contracts";
  export {
    createWebhookProviderRegistry,
    registerWebhookProvider,
    getWebhookProvider,
  } from "./registry";
  export { webhookIngressRoutes } from "./ingress";
  ```
  (Match the registry.ts's actual exported names exactly — inspect the file first
  rather than assuming these names verbatim.)
- `packages/agora/src/events/webhooks/inbound/webhook.test.ts` — moved from
  `apps/chrono-api/src/modules/webhook/webhook.test.ts`, with its `chronoWebhookEvent`
  import changed to `import { webhookEvent } from "agora/db/schema";` and every
  reference renamed. The test's own PGlite DDL bootstrap (table/index creation from
  Drizzle table configs) must still work — this table now needs to be part of
  whatever schema-introspection list that test uses; if it currently imports the
  Chrono app's `db/schema.ts` module for that list, it must now instead import from
  `agora/db/schema` (or wherever this moved test's own harness resolves its table set
  from — inspect the current test's setup before assuming which).

#### Files to Update

- `packages/agora/src/core/db/schema/platform.ts` — add the `webhookEvent` table
  definition (moved from `apps/chrono-api/src/modules/webhook/schema.ts`, table name
  `"ChronoWebhookEvents"` → `"WebhookEvents"`, Drizzle export name `chronoWebhookEvent`
  → `webhookEvent`, `NewChronoWebhookEvent`/`ChronoWebhookEventRow` types →
  `NewWebhookEvent`/`WebhookEventRow`). Every column, the unique index on
  `(provider, providerEventId)`, and the `tenantId` index stay identical — only names
  change. Import `organization` from the sibling `./auth.ts` in this same schema
  directory (not `agora/db/schema`, since this file IS part of that barrel — check how
  `platform.ts`'s other tables import `organization` today and match that exact
  import path).
- `packages/agora/src/core/db/schema/index.ts` — already does `export * from
  "./platform"`; no change needed here (confirm `platform.ts`'s new table is a plain
  named export, not something requiring an additional explicit re-export).
- `packages/agora/package.json` — add `"./webhooks/inbound":
  "./src/events/webhooks/inbound/index.ts"` to the `exports` map, alongside the
  existing `"./webhooks": "./src/events/webhooks/index.ts"` entry.
- `apps/chrono-api/src/db/schema.ts` — remove the `import { chronoWebhookEvent } from
  "../modules/webhook/schema";` line and its corresponding entry in the `export {
  ... }` block (currently commented "Platform-global, NOT tenant-scoped — deliberately
  absent from APP_TENANT_TABLES below"); add `webhookEvent` to the destructured
  `export const { user, ..., tenantIntegration, ... } = base;` block instead (it now
  arrives via the foundation, exactly like `tenantIntegration`/`billingEvent`).
- `apps/chrono-api/src/app.ts` — change `import { webhookIngressRoutes } from
  "./modules/webhook/ingress";` to `import { webhookIngressRoutes } from
  "agora/webhooks/inbound";`. The `.route("/api/v1/webhooks", webhookIngressRoutes())`
  mount itself is unchanged.
- `apps/chrono-api/src/payment-bootstrap.ts` — change `import { registerWebhookProvider
  } from "./modules/webhook/registry";` to `import { registerWebhookProvider } from
  "agora/webhooks/inbound";`.
- `apps/chrono-api/src/modules/webhook/adapters/paymongo.ts` — change `import type {
  CanonicalWebhookEvent, ResolvedWebhookScope, WebhookProviderAdapter } from
  "../contracts";` to `from "agora/webhooks/inbound";`. No other change — PayMongo's
  own adapter logic is business-specific and stays in `apps/chrono-api`.
- `apps/chrono-api/src/modules/webhook/adapters/paymongo.test.ts` — update its import
  of `createWebhookProviderRegistry` (currently `from "../registry"`) to `from
  "agora/webhooks/inbound"`, and its import of `chronoWebhookEvent`/`webhookEvent`
  (currently `from "../schema"`) to wherever it now resolves via the app's own
  `db/schema.ts` (it already imports `appSchema` from `"../../../db/schema"` for its
  PGlite table-creation loop — that import path is unchanged, since `webhookEvent`
  will now flow through `base` into that same module).

#### Files to Delete

- `apps/chrono-api/src/modules/webhook/schema.ts`
- `apps/chrono-api/src/modules/webhook/contracts.ts`
- `apps/chrono-api/src/modules/webhook/registry.ts`
- `apps/chrono-api/src/modules/webhook/ingress.ts`
- `apps/chrono-api/src/modules/webhook/webhook.test.ts`

(`apps/chrono-api/src/modules/webhook/adapters/` — PayMongo's adapter + its test —
is NOT deleted; it stays, only its import paths change, per "Files to Update" above.)

#### Step-by-Step Tasks

1. Read the current content of every file listed in "Files to Delete" and
   "Files to Update" before touching anything, to copy exact current logic rather than
   reconstructing from memory.
2. Create the four files under `packages/agora/src/events/webhooks/inbound/`
   (contracts, registry, ingress, index barrel) per "Files to Create" above.
3. Add `webhookEvent` to `packages/agora/src/core/db/schema/platform.ts`, matching this
   plan's Phase 1 column list exactly (just renamed).
4. Add the `"./webhooks/inbound"` export to `packages/agora/package.json`.
5. Update `apps/chrono-api/src/db/schema.ts`, `app.ts`, `payment-bootstrap.ts`,
   `modules/webhook/adapters/paymongo.ts`, `modules/webhook/adapters/paymongo.test.ts`
   per "Files to Update" above.
6. Delete the five files listed in "Files to Delete".
7. Move `apps/chrono-api/src/modules/webhook/webhook.test.ts`'s content into
   `packages/agora/src/events/webhooks/inbound/webhook.test.ts`, fixing its imports.
8. Run `pnpm typecheck` across the whole workspace (not just chrono-api — this touches
   `packages/agora`, which every app depends on) and fix anything that breaks.
9. Do NOT run `pnpm db:generate`/`pnpm db:migrate`/`pnpm --filter @agora/api rls:proof`
   — these require `DATABASE_URL_ADMIN` and a real Postgres connection this
   environment does not have. Leave the schema change uncommitted-to-DB; the developer
   runs migration generation locally as a separate step after this phase's code lands
   (see "Execution Start Point").

#### Acceptance Criteria

- `packages/agora/src/events/webhooks/inbound/` exists with the four moved/created
  files; `apps/chrono-api/src/modules/webhook/` contains ONLY `adapters/` afterward.
- `webhookEvent` is defined once, in `packages/agora/src/core/db/schema/platform.ts`,
  and reachable as `agora/db/schema`'s `webhookEvent` export.
- `apps/chrono-api/src/db/schema.ts` no longer has its own webhook table — it gets
  `webhookEvent` via the `base` destructure, exactly like `tenantIntegration`.
- No file outside `packages/agora` still imports from
  `apps/chrono-api/src/modules/webhook/{schema,contracts,registry,ingress}` (deleted).
- `apps/chrono-api/src/modules/webhook/adapters/paymongo.ts` and its test import the
  adapter contract types/registry/ingress from `agora/webhooks/inbound`, not a local
  relative path.
- `pnpm typecheck` (workspace-wide) passes.
- The relocated `webhook.test.ts` (now in `packages/agora`) and
  `paymongo.test.ts` (still in `apps/chrono-api`) both still pass against PGlite,
  proving the move didn't change runtime behavior.

#### Verification Commands

```
pnpm typecheck
pnpm --filter @agora/chrono-api test:webhook
```
(`test:webhook`'s script definition may need its path updated if the moved test file's
new location changes how it's invoked — e.g. if package.json's script for the
foundation-side test needs to live under `packages/agora`'s own `package.json` instead;
resolve this concretely during implementation by checking whether `packages/agora` has
any existing test-script convention for its own `*.test.ts` files, or whether Chrono's
`test:webhook` script should simply point its `tsx` invocation at the new
`packages/agora` path — pick whichever matches how `packages/agora`'s existing code,
if any, runs its own standalone tests today.)

#### Out of Scope

- Generating or applying the actual database migration (`db:generate`/`db:migrate`) —
  done locally, after this phase's code is pulled and verified (see below).
- `rls:proof` — also run locally, after migration.
- Any change to PayMongo's adapter logic, Phase 2's acceptance criteria, or
  `fulfilCustomerPayment`.
- Promoting anything else besides this webhook ingress mechanism to the foundation.

#### Execution Start Point

Delegate the file-move + import-path-fix work above to Jules (it needs no DB/secrets).
Once pulled and `pnpm typecheck` passes locally, the developer (this session) runs,
locally, in this order: `pnpm db:generate --name add-webhook-events` (review the
generated SQL — it should be a single `CREATE TABLE "WebhookEvents"` plus its two
indexes, nothing else), `pnpm db:migrate`, then `pnpm --filter @agora/api rls:proof` to
confirm the unrelated schema-file change didn't disturb tenant isolation elsewhere —
this is the one step this phase cannot outsource to Jules.

### Phase 4 — Second provider

Migrate a second, genuinely different provider (Maya or Paddle) with zero changes to
the domain/payment architecture built in Phase 2 — the proof the architecture is
provider-independent. **Deferred by developer decision** (2026-09-09): building a real
second PSP integration from scratch (no existing Maya/Paddle code, credentials, or
signing-scheme research in this repo) is a materially bigger, more product-shaped task
than an architecture proof warrants. Phase 5 (below) proves genericity instead, by
moving the foundation's own Stripe/Xendit/PayMongo billing providers onto this ingress
— reusing Xendit's already-real vendor code
(`packages/agora/src/commerce/billing/vendors/xendit.ts`) rather than building a new
provider from nothing. Revisit a genuine Maya/Paddle customer-payment integration later
if/when the business actually needs one.

### Phase 5 — Platform integrations (Stripe/Xendit/PayMongo billing)

**Status: Accepted**, delegated to Jules fire-and-forget (developer switching
machines — see the handover ledger for how to check back in).

Move `/billing/webhook`'s Stripe/PayMongo/Xendit dispatch onto this same ingress (now
foundation-hosted per Phase 3), reusing `packages/agora/src/commerce/billing/`'s
existing `BillingWebhookProvider` (`verifyWebhook`/`parseEvent`/`parseTransactionEvent`/
`identifyEvent`) and `applyWebhookEvent`/`recordTransactionEvent` unchanged — this phase
changes how a verified event reaches those functions, never what they do with one,
mirroring Phase 2's own "reuse, do not rewrite" stance toward `fulfilCustomerPayment`.
Unlike PayMongo customer-payments' per-tenant secret, billing providers use ONE static
platform-wide secret/token per provider (env-configured) — no brute-force
candidate-secret search needed; `verifySignature` is a direct single check.

#### Design decisions (resolved here, so Jules has zero open questions)

1. **Naming collision, resolved**: PayMongo is already registered as `"paymongo"` for
   customer-payments (Phase 2). Billing's PayMongo option would collide. **Billing's
   PayMongo adapter registers as `"paymongo-billing"`** (URL:
   `/api/v1/webhooks/paymongo-billing`), a distinct id/adapter from the customer-payments
   one — the two serve entirely different accounts/purposes and must never share a
   registry key.
2. **This code belongs in `packages/agora`, not `apps/chrono-api`.** Billing itself is
   foundation-generic (`packages/agora/src/commerce/billing/`, used by `apps/agora-api`
   too, per `.ai/plans/agora/archive/xendit-webhook-event-types/`). Unlike PayMongo's
   customer-payments adapter (genuinely Chrono-specific business logic), a billing
   webhook adapter is exactly the "a second business app would need it too" case Phase 3
   was built to support — so it lives in the foundation and each app's own bootstrap
   registers it, mirroring how `registerCustomerPaymentFulfilment` is called per-app
   today.
3. **Only ONE billing adapter is registered at boot, matching the active
   `BILLING_PROVIDER` env value — not all three simultaneously.** `recordTransactionEvent`
   internally calls `getBillingProviderId()` to stamp `payment_transaction.paymentProvider`
   — it does NOT take the calling provider as a parameter. If multiple adapters were
   registered at once and a webhook arrived on, say, `/api/v1/webhooks/xendit` while
   `BILLING_PROVIDER=stripe`, the stored `paymentProvider` would be wrong. Registering
   only the one adapter matching the current env value (exactly mirroring today's
   single-driver behavior) keeps `getBillingProviderId()` and "the adapter actually
   receiving traffic" in sync by construction, with zero changes to
   `recordTransactionEvent`'s signature (explicitly out of scope, matching Phase 2's
   stance on `fulfilCustomerPayment`).
4. **One canonical event can trigger TWO downstream writes** — a single billing webhook
   payload can carry both a subscription-state change (`applyWebhookEvent`) AND a
   transaction record (`recordTransactionEvent`), and the legacy route deliberately runs
   BOTH parse entrypoints unconditionally (see `app.ts`'s existing comment: "two DISJOINT
   parse entrypoints, both run so neither is swallowed by the other's null"). The new
   adapter's `dispatch()` preserves this exactly — it is not limited to one call.
   `resourceType`/`resourceId` on the canonical event (used only for the audit
   trail/idempotency row, never for dispatch logic) are set from whichever parse
   succeeded: `"subscription"` if `parseEvent` produced a `ParsedSubscription`, else
   `"transaction"` if `parseTransactionEvent` produced a `ParsedTransaction`, else
   `null`/`null` if neither did (an event this driver doesn't care about — still
   persisted, per Phase 1's "unknown/unsupported events must be recorded, not silently
   discarded").
5. **`scope` is always `"platform"`** for every billing adapter (Chrono's own single
   account per provider — no tenant-owned billing accounts exist), with `tenantId: null`
   on the canonical event, exactly like PayMongo's platform-fallback case in Phase 2.
   `dispatch()` still resolves and mutates the REAL affected tenant internally (via
   `parsed.tenantId`/`recordTransactionEvent`'s own customer-id fallback lookup) — the
   canonical event's `tenantId: null` describes account ownership, not "no tenant is
   affected."

#### Files to Create

- `packages/agora/src/commerce/billing/webhook-adapter.ts` — exports
  `createBillingWebhookAdapter(driver: "stripe" | "xendit" | "paymongo", secretEnvVar:
  string): WebhookProviderAdapter` (a factory, not a singleton — parameterized by which
  vendor `BillingWebhookProvider` to wrap, via `getBillingWebhookProvider(driver)`) and
  `registerActiveBillingWebhookProvider(): void`, which reads `getBillingProviderId()`,
  picks the matching secret env var (`STRIPE_WEBHOOK_SECRET` /
  `XENDIT_WEBHOOK_TOKEN` / `PAYMONGO_WEBHOOK_SECRET` — same env vars `app.ts`'s
  `/billing/webhook` route already reads), computes the registry id (`driver === "paymongo"
  ? "paymongo-billing" : driver`), and calls `registerWebhookProvider(id,
  createBillingWebhookAdapter(driver, secretEnvVar))`. No-ops (does not register, does
  not throw) if the matching secret env var is unset — mirrors the legacy route's own
  `if (!secret) throw new HttpError(400, ...)` becoming "this adapter simply never
  receives valid traffic" instead of a boot-time crash, since an unconfigured billing
  webhook is a normal state in dev.
- `packages/agora/src/commerce/billing/webhook-adapter.test.ts` — adapter-level tests
  (see Acceptance Criteria), reusing whatever fixture/signing helpers
  `packages/agora/src/commerce/billing/`'s existing test files (e.g. wherever
  `billing-transactions.test.ts`-equivalent coverage lives for this package, per
  `.ai/plans/agora/archive/xendit-webhook-event-types/README.md`'s own test file
  reference) already use — inspect and reuse, don't reinvent signing/fixture code a
  third time.

#### Files to Update

- `apps/chrono-api/src/payment-bootstrap.ts` — add a call to
  `registerActiveBillingWebhookProvider()` (imported from `agora/billing` or
  `agora/billing/server` — match whichever existing export path this new function is
  added under; add it to the SAME barrel `getBillingProviderId`/`getBillingWebhookProvider`
  already export from, not a new one).
- `packages/agora/src/commerce/billing/index.ts` (or wherever `getBillingProviderId`/
  `getBillingWebhookProvider` are currently exported from) — export
  `registerActiveBillingWebhookProvider` alongside them.

#### Files NOT Touched (explicit — this phase does not cut over production traffic)

- `apps/chrono-api/src/app.ts`'s `/billing/webhook` route — untouched, still live,
  still receiving real provider traffic. The new `/api/v1/webhooks/{stripe|xendit|
  paymongo-billing}` routes exist alongside it, receiving no real traffic until Phase 6
  repoints provider dashboards.
- `applyWebhookEvent`, `recordTransactionEvent`, `getBillingProviderId`,
  `getBillingWebhookProvider`, `BillingWebhookProvider`, or any `vendors/*.ts` file —
  zero changes to any of these; this phase only adds a new caller.

#### Step-by-Step Tasks

1. Read `packages/agora/src/commerce/billing/types.ts` (already reviewed in this plan's
   Pass 2 — `BillingWebhookProvider`'s exact 4 methods) and `apps/chrono-api/src/app.ts`'s
   current `/billing/webhook` handler (~lines 829-953) side by side — the new adapter's
   `verifySignature`/`parseEvent`/`resolve`/`normalize`/`dispatch` must reproduce that
   handler's logic exactly, just restructured into the `WebhookProviderAdapter` shape.
2. Write `webhook-adapter.ts`:
   - `verifySignature(input)`: read the header the driver expects (`stripe-signature` /
     `x-callback-token` / `paymongo-signature` — same mapping `app.ts` already has) and
     call `provider.verifyWebhook({ payload: input.raw, header, secret })`; throw
     `HttpError(400, "Invalid webhook signature.")` on failure.
   - `parseEvent(input)`: call BOTH `provider.parseEvent(input.raw)` and
     `provider.parseTransactionEvent(input.raw)`; throw `HttpError(400, "Invalid webhook
     payload.")` only if the raw body itself is unparseable JSON (mirror `app.ts`'s own
     `try { event = JSON.parse(payload) } catch { throw ... }` — reuse `identifyEvent`'s
     own internal parse if it already surfaces this, don't parse JSON a third time).
     Return `{ parsedSubscription, parsedTxn, eventId, eventType }` (from
     `provider.identifyEvent(input.raw)`) as the opaque `parsed` object threaded to
     `resolve`/`normalize`/`dispatch`.
   - `resolve(parsed)`: always `{ scope: "platform", tenantId: null, integrationId:
     null, providerAccountId: null }` — no I/O needed (unlike PayMongo customer-payments,
     there's no candidate-secret search here; `verifySignature` already proved which
     single account this is).
   - `normalize(parsed, resolved)`: `provider` = the registry id used
     (`"stripe"`/`"xendit"`/`"paymongo-billing"`), `providerEventId` = `parsed.eventId`,
     `eventType` = `parsed.eventType`, `resourceType`/`resourceId` per design decision 4
     above, `scope`/`tenantId`/`integrationId`/`providerAccountId` from `resolved`. Thread
     `parsed.parsedSubscription`/`parsed.parsedTxn` to `dispatch` via the same
     per-request `WeakMap`-keyed-by-canonical-event pattern Phase 2's PayMongo adapter
     already established (`adapters/paymongo.ts`) — reuse that exact pattern, don't
     invent a second mechanism.
   - `dispatch(canonical)`: read the threaded `parsedTxn`/`parsedSubscription` from the
     WeakMap. If `parsedTxn` is non-null, call `recordTransactionEvent(parsedTxn)`
     (best-effort — it already skips-and-logs an unresolvable tenant internally, per its
     own documented behavior). If `parsedSubscription` is non-null, call
     `applyWebhookEvent(canonical.providerEventId, canonical.eventType,
     parsedSubscription)` and reproduce `app.ts`'s existing post-call audit logic
     (`recordAudit` for `billing.subscription_created`/`_updated`/`_canceled`/
     `_webhook_suppressed`) verbatim — copy that block, don't summarize it.
3. Add `registerActiveBillingWebhookProvider()` per "Files to Create" above.
4. Wire it into `apps/chrono-api/src/payment-bootstrap.ts`.
5. Write `webhook-adapter.test.ts` covering the Acceptance Criteria below.

#### Acceptance Criteria

- With `BILLING_PROVIDER=xendit` and `XENDIT_WEBHOOK_TOKEN` set, a validly-signed Xendit
  invoice-paid callback posted to `/api/v1/webhooks/xendit` produces a `WebhookEvents`
  row (`scope: "platform"`) AND results in the same subscription-state change
  `/billing/webhook` would have produced for the equivalent payload (verified by reading
  the tenant's `tenant_subscription` row after).
- The same test repeated with `BILLING_PROVIDER=stripe`/`STRIPE_WEBHOOK_SECRET` against
  `/api/v1/webhooks/stripe`, and `BILLING_PROVIDER=paymongo`/`PAYMONGO_WEBHOOK_SECRET`
  against `/api/v1/webhooks/paymongo-billing`.
- A charge/refund-shaped event (not a subscription event) produces a `payment_transaction`
  row via `recordTransactionEvent`, with no `WebhookEvents.resourceType` claiming
  `"subscription"`.
- An invalid signature → `HttpError(400)`, no `WebhookEvents` row, no
  `applyWebhookEvent`/`recordTransactionEvent` call.
- Replaying the identical payload twice → second call deduped via `WebhookEvents`'s own
  `(provider, providerEventId)` index; `applyWebhookEvent`'s OWN separate idempotency
  (the `billingEvent` table) means even a bypassed dedup wouldn't double-apply — but the
  test still asserts the outer dedup fires first, before `dispatch()` runs a second time.
- With `BILLING_PROVIDER` unset/empty, `registerActiveBillingWebhookProvider()` does not
  throw and does not register any adapter — `getWebhookProvider("stripe")` etc. all
  return `null`.
- `/billing/webhook` (the legacy route) is provably untouched — no diff in `app.ts`.
- `pnpm typecheck` passes.

#### Verification Commands

```
pnpm typecheck
pnpm --filter @agora/chrono-api test:webhook
```
(Add whatever new test script invokes `webhook-adapter.test.ts` — following this
package's/`packages/agora`'s existing convention for running a standalone `*.test.ts`
file; inspect first rather than assuming a script name.)

#### Out of Scope

- Cutting over production traffic (repointing Stripe/Xendit/PayMongo dashboard webhook
  URLs) — Phase 6.
- Deleting `/billing/webhook` — Phase 6.
- Any change to `applyWebhookEvent`, `recordTransactionEvent`, or any `vendors/*.ts`
  file's own parsing logic.
- Registering more than one billing adapter simultaneously — explicitly not needed
  until/unless a future phase changes `recordTransactionEvent` to take an explicit
  provider parameter instead of reading env.

#### Execution Start Point

Start with `webhook-adapter.ts`'s `verifySignature`+`parseEvent` (lowest risk, mirrors
existing `app.ts` logic almost verbatim), then `resolve` (trivial, no I/O), then
`normalize`, then `dispatch` (the largest piece — copy `app.ts`'s existing
audit-logic block verbatim rather than re-deriving it), then
`registerActiveBillingWebhookProvider`, then wire `payment-bootstrap.ts`, then
`webhook-adapter.test.ts` last.

### Phase 6 — Legacy route deletion (mandatory, not optional)

Delete `/billing/webhook`, `/payments/customer/webhook/platform`, and
`/payments/customer/webhook/:token` from `app.ts` entirely, along with any code that
existed only to serve them (e.g. `getBillingWebhookProvider` call sites specific to
these routes, `findTenantByCustomerPaymentWebhookToken` if nothing else uses it,
`platformCustomerPaymentWebhookRoutes()` if fully superseded). This only happens AFTER
Phase 5 proves the new ingress handles the same three flows correctly against real
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
