# Algolia search integration for `/discover`

**Sessions:**
- Planning: algolia-search-provider-integration [10bb99]
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Context

`https://chrono2.izur.com.ph/discover` lets the public search for tenants (e.g.
searching "gaming" should surface "IZUR Gaming"). Investigation confirmed the
current backend match logic (`ILIKE '%q%'` against `organization.name`/`slug`,
in `apps/chrono-api/src/modules/business-lead/routes.ts:179-323`) is already
correct plain substring keyword matching — the live-site symptom was most
likely deploy lag (the feature was built 2026-09-06/07 and the deployed API
may predate it), not a code bug.

The developer has since asked to move past the ILIKE approach and integrate
**Algolia** as a real search backend — better relevance, typo-tolerance, and a
foundation for future growth-loop search needs, rather than continuing to
debug/harden raw SQL `ILIKE`.

Per `.ai/rules/providers.md` ("Adding a brand-new category"), every third-party
service category in this repo is a swappable **provider** behind an interface
— never a hardcoded vendor call in route code. There is currently no "search"
category (confirmed: zero references to Algolia/Typesense/Meilisearch/
Elasticsearch/OpenSearch anywhere in the repo). This plan adds one, following
the exact shape of the existing `email`/`storage` provider categories, then
wires Chrono's `/discover` search to use it.

**Split of ownership** (per `.ai/rules/architecture.md`, `.ai/rules/business-app.md`):
- The generic **search provider abstraction** (interface, registry, Algolia
  vendor, a safe local-dev default) is business-domain-neutral → belongs in
  `packages/agora`, exactly like `providers/email`/`providers/storage`.
- **What gets indexed and when** (organization name/branding/city, reindex on
  landing-page publish/unpublish) is Chrono-specific business logic → stays in
  `apps/chrono-api/src/modules/business-lead/`.

No new database tables or migrations are needed — the existing generic
Postgres-backed job queue (`packages/agora/src/events/queue/`, table `Jobs`,
already foundation-scoped) is reused for async reindexing; it has no prior
consumer in `apps/chrono-api` today, so this plan is the first.

## Phase 1 — Foundation: `search` provider category (`packages/agora`)

**Files to create:**
- `packages/agora/src/core/server/providers/search/types.ts` — interface:
  ```ts
  export type SearchRecord = { objectId: string } & Record<string, unknown>;
  export type SearchHit = { objectId: string } & Record<string, unknown>;
  export interface SearchIndex {
    provider: string;
    upsert(indexName: string, records: SearchRecord[]): Promise<void>;
    delete(indexName: string, objectId: string): Promise<void>;
    search(
      indexName: string,
      query: string,
      opts?: { filters?: string; hitsPerPage?: number },
    ): Promise<SearchHit[]>;
  }
  export class SearchIndexError extends Error {
    constructor(public provider: string, public status: number | null, message: string) { super(message); this.name = "SearchIndexError"; }
  }
  export const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 5000;
  ```
- `packages/agora/src/core/server/providers/search/vendors/memory.ts` — safe
  local-dev default (mirrors `console`/`local`): an in-process
  `Map<indexName, Map<objectId, record>>`; `search()` does a case-insensitive
  substring match across every string field of each stored record, and an
  exact-match check against any `filters` key (simple `key:"value"` parsing,
  matching only the subset this app actually uses — do not build a general
  Algolia filter-string parser).
- `packages/agora/src/core/server/providers/search/vendors/algolia.ts` — real
  HTTP vendor, no SDK (same convention as `vendors/resend.ts`/`vendors/s3.ts`):
  - `upsert`: `POST https://{appId}.algolia.net/1/indexes/{indexName}/batch`,
    body `{ requests: records.map(r => ({ action: "updateObject", body: { ...r, objectID: r.objectId } })) }`.
  - `delete`: `DELETE https://{appId}.algolia.net/1/indexes/{indexName}/objects/{objectId}`.
  - `search`: `POST https://{appId}-dsn.algolia.net/1/indexes/{indexName}/query`,
    body `{ query, filters, hitsPerPage }`, map `hits[].objectID` → `objectId`.
  - Headers: `X-Algolia-Application-Id`, `X-Algolia-API-Key`,
    `content-type: application/json`. `AbortController` + `SEARCH_TIMEOUT_MS`
    ceiling and `redirect: "error"`, mirroring `vendors/resend.ts` /
    `probes.ts`'s SSRF-hardening stance. Throw `SearchIndexError` on
    non-2xx/timeout, not a swallowed failure.
- `packages/agora/src/core/server/providers/search/registry.ts` — selector:
  ```ts
  export function getSearchIndex(): SearchIndex {
    if (cached) return cached;
    const provider = process.env.SEARCH_PROVIDER ?? "memory";
    switch (provider) {
      case "memory": cached = new MemorySearchIndex(); break;
      case "algolia": cached = new AlgoliaSearchIndex({
        appId: requireEnvKey("ALGOLIA_APP_ID", provider),
        apiKey: requireEnvKey("ALGOLIA_ADMIN_API_KEY", provider),
      }); break;
      default: throw new Error(`SEARCH_PROVIDER=${provider} is not supported — use "memory" or "algolia".`);
    }
    return cached;
  }
  ```
  (reuse the `requireEnvKey`-style helper already established in
  `providers/email/registry.ts`, don't reinvent it — export a shared copy or a
  small local equivalent).
- `packages/agora/src/core/server/providers/search/index.ts` — barrel export
  (`getSearchIndex`, types).

**Files to edit:**
- `packages/agora/src/core/contracts/integrations.ts` — add `"search"` to
  `PLATFORM_INTEGRATION_CATEGORIES`, and a `search` entry to
  `PLATFORM_INTEGRATIONS` (label "Search", `providers: ["algolia"]`,
  `credentialEnv: ["ALGOLIA_ADMIN_API_KEY"]`, `testable: true`,
  `acceptsSecret: false`), following the `storage` entry's shape.
- `packages/agora/src/observability/integrations/probes.ts` — add
  `probeSearch()` (mirrors `probePayment`'s Stripe balance-check shape): if
  `SEARCH_PROVIDER !== "algolia"` return `{ testable: false, ok: false, message: null }`;
  else check `ALGOLIA_APP_ID`/`ALGOLIA_ADMIN_API_KEY` present, then
  `GET https://{appId}.algolia.net/1/indexes` with the same
  `AbortController`/`redirect: "error"` timeout pattern; wire
  `if (category === "search") return probeSearch();` into
  `runIntegrationProbe`.
- `packages/agora/src/core/server/routes/landing.ts` — add a symmetrical
  `onUnpublish?: (tenantId: string) => Promise<void>` to
  `LandingRoutesOptions`, called fire-and-forget (`void onUnpublish(tenantId).catch(() => {})`)
  after the existing unpublish DB write, exactly like the existing `onPublish`
  call site. This is required so a tenant that unpublishes gets pulled from
  the search index, not just tenants that publish.
- `apps/agora-api/.env.example` — new documented block (mirror the existing
  "Object storage" block's style):
  ```
  # ─── Search index (Algolia) ──────────────────────────────────────
  # Provider for third-party search indexing (e.g. Chrono's /discover).
  #   memory  → in-process, non-persistent index (default; fine for local dev,
  #             data is lost on restart and must be reindexed via each app's
  #             own backfill/seed hook).
  #   algolia → Algolia (requires ALGOLIA_APP_ID + ALGOLIA_ADMIN_API_KEY).
  # SEARCH_PROVIDER="memory"
  # Required only when SEARCH_PROVIDER=algolia.
  # ALGOLIA_APP_ID="xxxxxxxxxx"
  # ALGOLIA_ADMIN_API_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  ```

**Acceptance criteria:** `getSearchIndex()` resolves to `MemorySearchIndex` with
no env vars set; setting `SEARCH_PROVIDER=algolia` without `ALGOLIA_APP_ID`
throws a clear error; `PLATFORM_INTEGRATIONS.search` exists and
`runIntegrationProbe("search", "algolia")` returns a real probe result when
configured; no new DB schema.

**Verification:** `pnpm typecheck`.

## Phase 2 — Chrono: index-sync pipeline (`apps/chrono-api`)

**Files to create:**
- `apps/chrono-api/src/modules/business-lead/search-sync.ts`:
  - `CHRONO_DISCOVER_SEARCH_INDEX = "chrono_businesses"` constant.
  - `buildSearchRecord(tenantId): Promise<SearchRecord | null>` — via
    `withAdmin`, join `organization` + `tenantLandingPage` (must have
    `published IS NOT NULL`, non-terminal `status` — same eligibility check
    as today's directory query) + `tenantBranding` (`displayName`, `tagline`,
    `logoUrl`) + the tenant's earliest active `chronoBranch` (`address` → a
    `city` field). Returns `null` if the tenant is not eligible (unpublished,
    terminal status, or missing).
  - `reindexTenant(tenantId: string): Promise<void>` — calls
    `buildSearchRecord`; if non-null, `getSearchIndex().upsert(CHRONO_DISCOVER_SEARCH_INDEX, [record])`;
    if null, `getSearchIndex().delete(CHRONO_DISCOVER_SEARCH_INDEX, tenantId)`.
  - `registerReindexJob()` — `registerJob("chrono.business-lead.reindex-tenant", async (payload, ctx) => { await reindexTenant((payload as { tenantId: string }).tenantId); })`
    (from `agora/server`'s queue barrel — confirm exact import path,
    `packages/agora/src/events/queue`, exported as e.g. `agora/server/queue` or
    similar; use whatever `apps/agora-api` itself imports it as, if it does —
    otherwise import directly from `agora`'s queue subpath export).
- One-off backfill script, `apps/chrono-api/src/modules/business-lead/backfill-search-index.ts`
  (invoked via a new `pnpm --filter @agora/chrono-api search:backfill` script
  in `package.json`): iterate every `organization` with a published
  `tenantLandingPage` (paginate, don't load all rows unbounded) and call
  `reindexTenant(id)` for each — needed once at rollout so the index isn't
  empty for already-published tenants, and reusable any time the index needs
  a full rebuild (e.g. after switching `SEARCH_PROVIDER`).

**Files to edit:**
- `apps/chrono-api/src/index.ts` — call `registerReindexJob()` and
  `startQueueWorker("search")` at boot (first consumer of this queue in
  Chrono; check exact env-tunable names, `QUEUE_SEARCH_POLL_MS` etc., already
  supported generically by `worker.ts`).
- `apps/chrono-api/src/routes/rpc.ts` (~line 1430, where `landingRoutes({ onPublish: notifyMatchedLeadsOnPublish })` is composed) — compose the reindex
  dispatch alongside the existing lead-notification hook, and add the new
  `onUnpublish`:
  ```ts
  landingRoutes({
    permission: { landingPage: ["manage"] },
    onPublish: async (tenantId) => {
      await Promise.allSettled([
        notifyMatchedLeadsOnPublish(tenantId),
        dispatch("chrono.business-lead.reindex-tenant", { tenantId }, { queue: "search" }),
      ]);
    },
    onUnpublish: (tenantId) =>
      dispatch("chrono.business-lead.reindex-tenant", { tenantId }, { queue: "search" }),
  }),
  ```
  (the job handler re-reads current DB state, so dispatching the same job type
  on unpublish correctly resolves to a delete — no separate job type needed).
- `apps/chrono-api/.env.example` — document `SEARCH_PROVIDER=algolia` +
  `ALGOLIA_APP_ID`/`ALGOLIA_ADMIN_API_KEY` as the recommended production
  values for this app specifically (referencing the foundation block added in
  Phase 1).
- `apps/chrono-api/src/seed.ts` — after seeding a tenant with a published
  landing page (if the seed does that), call `reindexTenant` so local dev data
  is searchable without a manual backfill run.

**Acceptance criteria:** publishing a landing page enqueues a `Jobs` row of
type `chrono.business-lead.reindex-tenant`; running the queue worker processes
it and the tenant appears in `getSearchIndex().search(...)`; unpublishing
removes it; the backfill script populates the index for pre-existing published
tenants with no errors.

**Verification:** `pnpm typecheck`; manually publish/unpublish a seeded tenant
locally (default `SEARCH_PROVIDER=memory`) and confirm the in-memory index
reflects it; run the backfill script against local dev DB.

## Phase 3 — Chrono: cut `/discover` search over to the search index

**Files to edit:**
- `apps/chrono-api/src/modules/business-lead/routes.ts` (the `GET /businesses`
  handler, ~lines 179-323): replace the ILIKE candidate-org query
  (`or(ilike(organization.name, pattern), ilike(organization.slug, pattern))`)
  with:
  ```ts
  const hits = await getSearchIndex().search(
    CHRONO_DISCOVER_SEARCH_INDEX,
    q,
    { filters: city ? `city:"${city}"` : undefined, hitsPerPage: DISCOVER_RESULT_LIMIT },
  );
  const tenantIds = hits.map(h => h.objectId);
  ```
  then scope the existing branch/location query and the live-availability
  aggregate query to `inArray(organization.id, tenantIds)` instead of the
  previous ILIKE-derived id list, and **re-sort the final merged results to
  match `hits` order** (Algolia's relevance ranking) before applying the
  existing demand-ranking boost step (`rankBusinessesByDemand`) — the boost
  logic is unchanged, it just now reorders a relevance-ranked list instead of
  an alphabetical one. Keep the existing `discoverCache` wrapping unchanged
  (still a 15s TTL keyed by normalized `q`+`city`). No response-shape change —
  `businessDirectoryResultSchema` (contracts.ts) is untouched.
- No change needed to `discoverBusinessesQuerySchema` or to
  `apps/chrono-web/src/lib/discover-client.ts` / `discover-search.tsx` — the
  request/response contract is identical; only the backend match algorithm
  changes.

**Tests:**
- Update/extend the existing cross-tenant e2e coverage
  (`apps/chrono-web/e2e/tests/growth/cross-tenant-isolation.spec.ts` and
  whatever spec currently covers `/discover`'s happy path) to run against
  `SEARCH_PROVIDER=memory` in the e2e/test environment (no real Algolia
  credentials needed in CI) — seed a published tenant, publish it (triggering
  the reindex job) or call `reindexTenant` directly in test setup, then assert
  a keyword substring search (e.g. "gaming" matching "IZUR Gaming") returns it.

**Acceptance criteria:** searching "gaming" against a published tenant named
"IZUR Gaming" (indexed via the Phase 2 pipeline) returns it; unpublished/
terminal-status tenants never appear; existing rate-limiting, caching, and
demand-ranking behavior is unchanged; e2e spec passes with `SEARCH_PROVIDER=memory`.

**Verification:** `pnpm typecheck`; run the updated e2e spec(s); manual check
against local dev (`pnpm dev`, publish a tenant, search for a keyword
substring of its name at `/discover`).

## Out of scope

- Any live-search/instant-search UX change on the frontend (current UI is
  submit-driven, not per-keystroke) — this plan only swaps the backend match
  algorithm, not the search UX.
- Indexing free-text landing-page content (the `published` jsonb blob) —
  MVP indexes only `organization.name`/`slug`, `tenantBranding.displayName`/
  `tagline`, and branch `city`. A richer content index is a future follow-up.
- Promoting the business-lead/discover mechanism itself to `packages/agora`
  (noted as a "foundation-promotion candidate" in `apps/chrono-api/AGENTS.md`
  if a second business app ever needs it — not triggered by this plan).
- Fixing/investigating the original deploy-lag hypothesis on
  `chrono2.izur.com.ph` — that's an ops/deploy question, separate from this
  code change.
- A `/admin/integrations` UI screen dedicated to "search" beyond what the
  existing data-driven `PLATFORM_INTEGRATIONS` registry already renders
  generically.

## Execution start point

Phase 1, starting with
`packages/agora/src/core/server/providers/search/types.ts`.
