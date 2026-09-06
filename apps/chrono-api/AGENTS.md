# Chrono — Agent Context

Read this after the root `AGENTS.md` and `.ai/rules/*` — this file only covers what's
specific to Chrono. It documents the `apps/chrono-api` + `apps/chrono-web` pair (one doc
for both, see `.ai/rules/business-app.md`, "Where rules live").

Chrono is a business app built on the Agora foundation (`.ai/rules/business-app.md`,
`.ai/rules/architecture.md` "Business Apps"). Every foundation rule (tenant isolation,
RBAC, DTO/contracts, component-first UI, e2e coverage) applies to Chrono exactly as it
applies to the scaffold — nothing here overrides them.

## Status

Migrating from an existing implementation, started 2026-09-01. Wave 1 is in progress —
`branches`, `stations` (+ station groups), `devices` (schema landed), `members`
(`ChronoMemberProfiles` extending `tenantMember`), `wallet`/`credits`, and `shifts` have
landed schema + RLS, with routes/permission gates and web UI landed for most (see
`.ai/plans/chrono/in-progress/*/README.md` for each module's exact phase status — some
are schema-only, others are through web UI + e2e). `sessions` is schema/contracts in
progress, not yet routed. `reservations` and `pos` (schema + Zod contracts) have also
landed ahead of the originally planned Wave 1 order (`reservations` is fully closed,
archived at `.ai/plans/chrono/archive/reservations/README.md`). See each module's plan
folder under `.ai/plans/chrono/in-progress/` (or `.ai/plans/chrono/archive/<module>/`
once closed) for the authoritative per-module status — this section is a snapshot, not
the source of truth.

## Business domain

Chrono is a gaming/internet-café venue-management product: branches (venue locations)
run stations (PC gaming seats) with paired kiosk devices; customers hold a wallet/credit
balance and run timed sessions on a station; staff work shifts. Loyalty, vouchers,
promos, POS, reservations, reporting/reconciliation, security alerts, QR flows, and
inquiries sit on top of that spine.

**Source**: an existing mature implementation at
`/Users/risurina/karta/karta-tenant` (`apps/chrono-api` + `apps/chrono-web` +
`packages/oikos`, built on a sibling foundation `@risurina/oikos`) is **prior art, not a
spec.** (An earlier revision of this file gave a Windows path,
`C:\Users\ronni\project\izur\oikos`, which is not reachable from a macOS
checkout — the source IS available at the path above, so do not conclude it is
inaccessible. Its live site is https://chrono.izur.com.ph/.)

This is a reimplementation on the Agora foundation, not a faithful port — oikos
shows what the product needs to do, not how every detail must be built. Default to
improving on oikos wherever its design is weak (dead/unused schema, missing constraints,
awkward naming, no transactional atomicity, a workaround for a problem Agora's
architecture doesn't have) rather than replicating it out of inertia. Match oikos's
behavior only where it's genuinely the right call or the developer asks for parity —
never as the default. Watch for the old implementation's own foundation-vs-business
boundary mistakes before repeating them here (e.g. a prior bespoke member system that
should have reused the foundation's tenant member pool instead of forking it — already
corrected, see `.ai/plans/chrono/archive/members/README.md`).

Every landed plan under `.ai/plans/chrono/{in-progress,archive}/*/README.md` already exercises this
judgment in places (see each plan's "deliberate differences from oikos" notes), but each
also leaves some "match oikos or diverge" calls as open questions for the developer.
Resolve those through this lens — lean toward the improvement, not toward parity — unless
there's a concrete reason to keep oikos's behavior.

## Modules

**Wave 1 (this migration pass)** — the operational spine, in dependency order:
`branches` → `stations` → `devices` (kiosk pairing/auth) → `members` (customer pool) →
`sessions` → `shifts` → `wallet`/`credits`. Each lands under
`apps/chrono-api/src/modules/<domain>/` per `.ai/rules/business-app.md`. Current state
(see each module's plan under `.ai/plans/chrono/in-progress/<module>/README.md` or, once
closed, `.ai/plans/chrono/archive/<module>/README.md`, for the authoritative phase-by-
phase status):

- `branch`, `station`, `member` (`ChronoMemberProfiles`), `shift` — schema + routes +
  permission gates landed; web UI landed for stations/shifts.
- `device` — schema + RLS landed (kiosk pairing/bearer-auth routes not yet built).
- `payment` — schema + routes + permission gates landed; web UI + e2e landed.
  Member-facing online checkout (credit-purchase / wallet-topup via the
  tenant's own PayMongo account, webhook-driven fulfilment) landed API-side
  (`.ai/plans/chrono/archive/member-credit-purchase/README.md`, Phases
  C1–C4); its web UI is superseded by `member-area`'s Phase 7, and its e2e
  spec is deferred until that UI lands.
- `wallet` — schema + RLS landed (staff routes not yet built; the member
  self-service top-up path is routed via `payment`'s own checkout, above).
- `session` — schema + contracts + money/expiry helpers + staff routes
  (`sessionRoutes()`, mounted at `apps/chrono-api/src/routes/rpc.ts`) + member
  portal routes landed. **`session/service.ts` writes `chronoStation.status`**:
  `"occupied"` on start, back to `"available"` on end. That last fact is
  load-bearing for anything reading station status — the public station contract
  used to allow only three statuses while sessions were already writing a
  fourth, so the whole public live-availability surface silently blanked out
  whenever a venue was busy (`getTenantStations()` re-validates and returns
  `null` on a parse failure). This entry previously read "contracts + money
  helpers in progress; no schema/routes yet", and that stale line is what let
  the mismatch be planned around rather than caught.
- `pos` and `reservation` landed ahead of their originally planned wave (`pos`: schema +
  contracts; `reservation`: schema, contracts, routes, web UI, e2e — plan archived at
  `.ai/plans/chrono/archive/reservations/README.md`). `reservation` has since gained a
  member self-service follow-up — direct booking, a queue/hold system, ban/restriction
  tracking, a per-tenant/branch policy, and a background sweep — API-side phases
  (schema, contracts, permissions, member portal routes, session-claim wiring, sweep)
  landed; member UI and e2e spec not yet built. See
  `.ai/plans/chrono/archive/reservations-queue-and-self-service/README.md` and
  `apps/chrono-docs/product/member-reservations.md`.

**Deferred (later waves, not in this pass)** — `reports`, `reconciliation`,
`security-alerts`, `qr`, `inquiries`, `onboarding-checklist`, `app-versions`,
`public-releases`, `admin-station-client`. Present in the source implementation; not
planned until Wave 1 is proven. `loyalty`, `voucher` and `promo` were listed here too,
but all three already have real schema under
`apps/chrono-api/src/modules/{loyalty,voucher,promo}/schema.ts` and are registered in
`APP_TENANT_TABLES` (`ChronoLoyaltyAccounts`, `ChronoLoyaltyTransactions`,
`ChronoVouchers`, `ChronoPromos`, `ChronoPromoRedemptions`) — they are landed at the
data layer, not deferred. Note none of them is surfaced on the public tenant site:
voucher codes are deliberately controlled-distribution, and no public promo DTO has
been agreed. `public-stations`, `tenant-landing`, and `app-usage` have since landed ahead
of the rest of this list — archived at `.ai/plans/chrono/archive/public-stations/README.md`,
`.ai/plans/chrono/archive/tenant-landing/README.md`, and
`.ai/plans/chrono/archive/app-usage/README.md`. `app-usage` (per-station app/game
telemetry: device-ingest, staff read routes, retention/stale-run sweep, web UI) landed
schema/routes/permissions/UI/e2e in full. `business-lead` (the two-sided growth loop —
public cross-tenant discovery, cold-start lead capture, and the tenant demand read)
landed schema/routes/permissions/UI/e2e in full; see "The growth loop" below and
`.ai/plans/chrono/archive/two-sided-growth-loop/README.md`.

**Out of scope for this pass** — `apps/chrono-mobile`, `apps/chrono-pc-client` (+
`-service`, `-tauri`), `apps/chrono-docs` from the source implementation. This pass is
`apps/chrono-api` + `apps/chrono-web` only; the API still needs to support device
pairing/bearer-auth (stations depend on it) even though the PC-client apps themselves
aren't being ported yet.

## Surfaces

Chrono's tenant-facing URLs match the reference site (`gaming.chrono.izur.com.ph`):

- **`{slug}.APP_DOMAIN/login`** — customer (member) sign-in (`agora/member-auth`,
  `tenantMember`) → `/member/*`, the member area (`(member-area)/member/**`;
  the gold-on-black shell + tab bar re-skinned from the reference site — see
  `.ai/plans/chrono/archive/member-area/README.md`). `/portal/{login, sign-up,
  forgot, reset, accept-invite}` stay at `/portal/*` — foundation emails
  hardcode those links — plus the apex `/portal/*` global-customer home
  below; `/portal` and `/portal/{reservations,inquiries}` on a tenant host
  redirect (`next.config.ts`, not middleware) to `/member`,
  `/member/reservations`, `/member/inquiries`.
- **`{slug}.APP_DOMAIN/admin/login`** — staff sign-in (Better Auth) → `/admin/*`.
- **`{slug}.APP_DOMAIN/admin/*`** — the tenant back office. This is a `next.config.ts`
  host-based rewrite (fires on any non-apex host — subdomain or verified custom
  domain) onto the physical `apps/chrono-web/src/app/(tenant-admin)/dashboard/*`
  tree. The folder keeps its scaffold name because the apex-only platform admin
  already owns `/admin/*` at the file-tree level (`(saas-admin)/admin/*`) and App
  Router path resolution is host-agnostic — two `page.tsx` files can't share a path.
  `/admin/login` is rewritten separately onto `(tenant-admin)/staff-login` so the
  login page sits outside the dashboard layout's session gate. Write new links as
  `/admin/...` (the public URL), never `/dashboard/...`. This is config-level URL
  aliasing only — no middleware; tenant/auth enforcement is unchanged (layout
  session checks + API-side RLS).
- **`APP_DOMAIN/login`** — apex staff sign-in with no tenant context yet (org
  selection / creation). **`APP_DOMAIN/portal/login`** — the platform-wide global
  customer identity (below). **`APP_DOMAIN/admin/*`** — platform admin, inherited
  from the scaffold unchanged.

`/login` is one host-branching page (`(saas-landing)/login/page.tsx`): the member
form on a tenant host, the staff form on the apex — the same "renders everywhere,
branches internally" pattern the app uses everywhere instead of middleware. The two
forms are `src/components/member-login-form.tsx` / `staff-login-form.tsx`.

- **`APP_DOMAIN/discover`** — public, unauthenticated cross-tenant business
  directory plus the cold-start "invite a business" form (`business-lead`
  module). Apex-only; see "The growth loop" below.
- **`APP_DOMAIN/portal/{sign-up,login}`** — apex sign-up/sign-in for the
  foundation's
  platform-wide global customer identity (`agora/customer-auth`, `customer` table,
  cookie `agora_customer`). (An earlier revision of this file listed these as
  `APP_DOMAIN/customer/*`; no `customer/` route group exists — the real paths are
  under `(member-portal)/portal/`.) Distinct from `{tenantSlug}.APP_DOMAIN/portal/*`'s
  tenant-only customer signup (`agora/member-auth`, `tenantMember`) — a global customer
  signs up once here, then self-service "applies" from a given tenant's `/portal`
  (`POST /portal/customer/apply`) to become a customer of that tenant. See
  `.ai/rules/business-app.md`, "Global customers", and
  `.ai/plans/agora/archive/global-customers/README.md`.
- **`{tenantSlug}.APP_DOMAIN/`** and **`{tenantSlug}.APP_DOMAIN/about`** — the
  tenant's own white-label public site. Both render the same registry-driven
  section list (see "Landing pages" below); `/` is the canonical URL and
  `/about` is kept for existing links. **They now behave identically for an
  unresolvable tenant.** They did not: `/about` called `getTenantLanding()` and
  `notFound()`, while `/`'s own `fetchTenant()` returned `null` for an unknown
  subdomain *and* for a real apex visit, so an unknown subdomain silently
  rendered the generic Chrono marketing page at that subdomain's URL. `/` now
  404s that case off `getTenantLanding()` — deliberately **not** off a fetch
  failure, since a transient API blip must degrade the page, never 404 a live
  tenant (`apps/chrono-web/src/lib/landing.ts` documents that distinction). A
  true apex host still falls through to the marketing branch unchanged.
  Both pages emit OpenGraph tags via `apps/chrono-web/src/lib/seo.ts`; `og:image`
  is the tenant's own logo when it has one and is omitted otherwise — no hero/OG
  image field exists and a placeholder would be a fabricated brand asset.
- **`{tenantSlug}.APP_DOMAIN/stations`** (verified custom domains resolve the same way)
  — public, unauthenticated live station-availability page (implemented:
  `.ai/plans/chrono/archive/public-stations/README.md`). Resolved via
  `getRequestTenant()` (`agora/next`) on the incoming host, exactly like the
  authenticated dashboard's own resolution — no session, no membership, no Next.js
  middleware. An unknown host or a tenant in a terminal lifecycle status
  (`suspended`/`cancelled`/`archived`/`deleting`) renders a 404, never stale or
  cross-tenant data. It now carries the same `TenantHeader`/`TenantFooter` chrome
  as the landing pages, and reports **four** honest status buckets — Available /
  In use / Maintenance / Offline. The old single "In Use / Offline" card sat over
  an aggregate the API computed as `maintenance + offline`, so a machine under
  maintenance was advertised as in use and a genuinely occupied one was counted
  nowhere.

## Unauthenticated routes

Every route reachable without a session mounts under `/public/*` or
`/api/v1/device/*` on `apps/chrono-api/src/app.ts` directly — **never** under
`/rpc`, which applies `tenantMiddleware()` (an anonymous caller 401s before the
handler runs) and gets the maintenance/read-only gates applied to `/rpc/*` (a
public page would 503 during maintenance). This is not a style preference: both
gates are wired onto `/rpc` specifically, so mounting a public route there
cannot work.

For any such route:

- **Rate-limit it.** Wrap it in `createRateLimiter` + `clientIp`, both exported
  from `agora/server` (`packages/agora/src/server/rate-limit.ts:172,184`), with
  limits pinned as concrete numbers at the mount site — never left as a TODO or
  deferred to "check if agora has a rate-limit primitive." The working
  precedent is the staff-credential throttle in
  `apps/chrono-api/src/app.ts:352-369` (`staffSignInLimiter` = 5/15min,
  `staffSignUpLimiter` = 10/hour, both `createRateLimiter(...)` calls at
  `app.ts:137-138`), which blocks by `clientIp(c)` and returns 429 with a
  `Retry-After` header.
- **Resolve tenant server-side and reject terminal statuses.** Never trust a
  client-supplied tenant, and never serve a `suspended`/`cancelled`/`archived`/
  `deleting` tenant. The working precedent is `/public/tenant`
  (`apps/chrono-api/src/app.ts:468`) and `/public/branding`
  (`apps/chrono-api/src/app.ts:477`), both mounted on the app outside `/rpc` and
  both resolving through `resolveOrgFromRequest`.
- **Never return a raw row.** Respond with an explicit column allowlist —
  no un-narrowed `$inferSelect` object reaching the client.

See `.ai/plans/chrono/archive/security-hardening/README.md` Phase 2 for the full
reasoning (the rate-limiting gap found across the `devices`/`qr`/`inquiries`/
`public-stations` plans was one convention gap, not four separate bugs).

`POST /payments/customer/webhook/:token` (member-credit-purchase plan) is the
newest member of this family: rate-limited 120/min per IP
(`customerPaymentWebhookLimiter`, `app.ts`), resolves its tenant from the path
token via `findTenantByCustomerPaymentWebhookToken` (a `withAdmin` read — no
session exists on an inbound webhook, so the token-hash match is the only
isolation on this specific path, same stance as the foundation's
`readPublishedLandingPage`), and never returns a raw row (just
`{ received, ignored?, deduped? }`). It is the one exception to "reject
terminal statuses": a suspended tenant's already-pending payment can still be
fulfilled by a webhook that predates the suspension — this surface does not
gate on tenant lifecycle status at all, since it never serves data back to
the caller (PayMongo), only records/mutates one row.

## Member online checkout (member-credit-purchase plan)

A member buys a credit pack or tops up their wallet online, from
`{slug}.APP_DOMAIN/member/promos` / `/member/wallet` (the wallet-funded catalog
purchase at `/member/promos/[id]` uses `/portal/credits/purchase` instead — see
`.ai/plans/chrono/archive/member-area/README.md`), via `modules/payment/portal-routes.ts`
(mounted `/portal/payments`, `memberMiddleware()`-gated):

- `GET /portal/payments/gateway` — `{ available, currency }`, read directly off
  the tenant's `customerPayment` integration row (not through
  `resolveCustomerPaymentGateway`, so it reports honestly even when no secret
  key is configured). The web UI must disable the Buy button rather than show
  a button that 400s.
- `POST /portal/payments/checkout` — `{ purpose: "credit_purchase" | "wallet_topup", productId? | amount? }`.
  `memberId`/`tenantId` always come from `c.var.member`, never the body. A
  `credit_purchase` reads its price server-side from the product; a
  `wallet_topup` amount is client-supplied but bounded (₱20–₱10,000,
  `modules/payment/contracts.ts`) and re-verified against the PSP-reported
  amount at fulfilment. Rate-limited 10/15min per member. Returns
  `{ paymentId, checkoutUrl }`.
- `GET /portal/payments/:id` — the caller's own payment only (`memberId` is
  part of the WHERE, not just tenant scope) — 404, not 403, for any other
  payment (no existence leak).

**Fulfilment is webhook-only** — `modules/payment/fulfilment.ts`'s
`fulfilCustomerPayment` is the ONLY place a payment row is ever marked
`paid`. The `/portal/credits?payment=<id>` return page the customer's browser
lands on must poll `GET /portal/payments/:id`, never assume success from the
redirect itself. See `.ai/plans/chrono/archive/member-credit-purchase/README.md`
for the full design (the two rollback traps around price drift and a
product going unsellable between checkout and webhook delivery) and
`docs/runbooks/customer-payment-webhook.md` for registering the webhook URL
in PayMongo and what an amount-mismatch row means operationally.

### Operation hardening (member-wallet-operation-hardening plan)

Both member-initiated mutations above, plus `POST /portal/credits/purchase`
(`modules/credit/portal-routes.ts`, the wallet-funded catalog purchase used
by `/member/promos/[id]`), carry three additional defenses — see
`.ai/plans/chrono/in-progress/member-wallet-operation-hardening/README.md` for the
full design:

- **CSRF-preflight header.** Every mutating handler calls
  `requireMemberActionHeader(c)` (`agora/member-auth`) first, before any DB
  work — mirrors `requireAdminHeader`'s platform-admin precedent. Requires
  `x-member-action: 1`; missing it is a 400 before the handler does anything
  else. `x-member-action` (and `Idempotency-Key`, below) are in `app.ts`'s
  CORS `allowHeaders` — a custom header is what forces the preflight, so the
  origin allowlist (`corsOrigin`) actually gets to run.
- **Optional `Idempotency-Key` header.** A client-supplied key, looked up
  against `chronoCreditPurchase.idempotencyKey` /
  `chronoPayment.idempotencyKey` (both a nullable column with a partial
  unique index on `(tenantId, memberId, idempotencyKey)`) before the mutation
  runs. Found → the ORIGINAL result is returned unchanged (200), no second
  wallet debit / no second PSP checkout session. Not found → proceeds
  normally, persisting the key. Omitted → today's behavior, unprotected. A
  race between two concurrent requests sharing a key is caught on the
  resulting unique-violation and resolved to the winner's row. `chronoPayment`
  also gained a `checkoutUrl` column so a replayed checkout can return the
  exact same redirect URL (previously only `providerReference`, the PSP's own
  id, was stored). The web client (`lib/member/payments.ts`,
  `lib/member/credits.ts`, and the `/member/wallet` / `/member/promos/[id]`
  components) generates this per user-initiated attempt and keeps it stable
  across a retry of that same attempt.
- **Fail-closed rate limiting.** `checkoutLimiter` / `purchaseLimiter` both
  pass `{ failOpen: false }` to `createRateLimiter` (`agora/server`) — on a
  Redis/Upstash outage these two money-moving routes block (429) rather than
  silently dropping throttling, the opposite of the process-wide
  `RATE_LIMIT_FAIL_OPEN` default every other limiter in this app still uses.

Explicitly out of scope for this pass (see the plan's own "Out of scope"):
MFA/step-up auth, broader member-portal session/lockout hardening, and a
daily/rolling online-payment velocity ceiling — considered and declined by
the developer; the per-transaction ₱20–₱10,000 bound and the 10/15min
checkout throttle remain the only volume limits.

## The growth loop (`business-lead` module)

Chrono's two-sided acquisition mechanic: a player looks for their gaming café on
the public apex directory, and when it isn't there, asks for it. If that business
later joins, it sees how many players had already asked.

**Do not confuse this module with the two other lookalikes.** All three capture
"someone wants something", and they are otherwise unrelated:

| Module | Who submits | Scope | Where it goes |
|---|---|---|---|
| `business-lead` | a signed-in GLOBAL customer (player) | platform-wide, pre-tenant | `ChronoBusinessLeads`, surfaced only as a per-tenant count |
| `company-inquiry` | anyone, anonymously | platform-wide (IZUR itself) | emailed to `SUPPORT_INBOX_EMAIL`, no row |
| `inquiry` | a tenant's own customer | one tenant | `ChronoInquiries`, a staff-facing queue |

**`ChronoBusinessLeads` is platform-global and NOT RLS-scoped**, and must never
enter `APP_TENANT_TABLES`: at capture time the business being asked for has no
tenant, so there is no `tenantId` to carry. It follows `supportTicket`'s shape.

- **Matching is lazy, at read time.** `GET /rpc/growth/demand` normalizes the
  caller's own organization name and counts leads whose stored
  `businessNameNormalized` equals it. There is deliberately no signup-time hook
  and no `matchedTenantId` column — the only place such a hook could live is the
  foundation's `organizationHooks.afterCreateOrganization`, which is out of
  bounds for a business app (`.ai/rules/business-app.md`, "Extension seams";
  there is no seam for org-creation callbacks). Read-time matching also
  self-heals on rename. `normalizeBusinessName()` is exported once from the
  module's contracts and shared by the insert and the read so the two cannot
  drift.
- **`growth: ["read"]` is admin+ only** — no `CHRONO_STAFF_GRANTS` entry. Demand
  data is commercial/acquisition intelligence, the tier of
  `report:readFinancial` / `landingPage:manage`, not front-desk work. Granting it
  to staff would also collapse the role gate into deny-by-default plumbing.
- **`rls:proof` does NOT cover this feature.** The table is outside RLS by
  design, so the server-derived normalized-name predicate on
  `GET /rpc/growth/demand` is its only isolation. The proof is the cross-tenant
  case in `src/e2e/run.ts` plus
  `apps/chrono-web/e2e/tests/growth/cross-tenant-isolation.spec.ts` — the same
  stance the foundation takes for `readPublishedLandingPage`.
- **Publishing a landing page IS consent to be listed** in the public directory.
  `GET /public/discover/businesses` lists a tenant only when its foundation
  `tenantLandingPage.published IS NOT NULL`; Chrono's legacy `ChronoLandingPages`
  content columns deliberately do NOT qualify, since they predate this surface
  and were never a decision to appear platform-wide. Unpublishing is an
  immediate, complete opt-out.
- The directory read runs in ONE `withAdmin` transaction covering all five
  RLS-forced tables it touches (`Organizations`, `TenantLandingPages`,
  `TenantBrandings`, `ChronoBranches`, `ChronoStations`) — a bare `adminDb` read
  of any of them returns zero rows silently. It is bounded (`LIMIT 20`, one
  grouped aggregate, ~15s cache) and excludes only TERMINAL tenant statuses, so
  `trial`/`pending` businesses stay visible.
- **No lead field is ever returned or logged.** The demand read is a bare
  `{ count }`; there is no lead-read surface, no admin triage console, and no
  notification in this version — so the submit toast says the request was
  recorded, never that anyone will be contacted. Erasure rides the
  `requesterCustomerId` cascade.
- **Foundation-promotion candidate**: if a second business app ever needs the
  same mechanic, this table and its routes belong in `packages/agora` per
  `.ai/rules/architecture.md`'s "if a second business app would need it too" rule.

## Landing pages

Chrono's public surfaces are the apex marketing page (`(saas-landing)/page.tsx`)
and each tenant's own landing page (`/` and `/about` on the tenant host). The
**tenant** page is fully configurable; the marketing page is not (its copy is
Chrono's, not a tenant's).

The machinery is the **foundation's** — config schema, section registry,
resolvers, `TenantLandingPages` storage, the route factory, and the
draft/publish gate all live in `packages/agora`. See `.ai/rules/business-app.md`,
"Extension seams", for the contract. Chrono owns only its vocabulary and its
appearance.

### Adding a section

One entry in `apps/chrono-web/src/components/landing/registry.ts`:

```ts
myThing: defineLandingSection({
  key: "myThing",
  label: "My thing",          // shown in the settings editor
  surface: "tenant",
  defaultEnabled: true,        // false = opt-in only
  defaultOrder: 60,            // spaced by 10 so you can slot between
  Component: TenantMyThing,
  propsFrom: (r, ctx) => ({ /* select from resolved config */ }),
}),
```

**No page file changes.** `/about` renders whatever `resolveLandingSections()`
returns, so ordering and visibility are settings, not code. `defineLandingSection`
type-checks `Component` against its own `propsFrom`, so a mismatch is a compile
error even though the registry map itself is prop-type-erased.

Sections live in `components/landing/tenant-sections.tsx`, composed **only** from
`agora/ui` primitives — no raw `div`/`span`/`ul` chrome. Give every section root
a `data-testid`; the e2e spec asserts presence *and* absence.

### The white-label section vocabulary

`CHRONO_LANDING_SECTIONS` gained three sections
(`.ai/plans/chrono/*/tenant-white-label-site`), all following the recipe above —
no page file changed:

- **`experience`** (order 35) — a chip row of the tenant's DISTINCT real
  `stationType` values, derived from the station payload the page has already
  fetched. **Zero extra API calls**, and a tenant with no stations renders
  nothing rather than an empty row.
- **`playerCta`** (order 18, right after live availability) — the join /
  sign-in moment. The section is server-rendered; only the actions are a client
  island (`PlayerCtaActions`), branching anonymous / signed-in global customer /
  existing member. It calls `useMemberSession()` + `useGlobalCustomerSession()`
  directly and must **never** reuse `MemberGate`, which hard-redirects anonymous
  visitors to `/login` — on a public marketing page that would bounce every
  visitor the page exists to convert. It defaults to the anonymous branch while
  either session is still resolving.
- **`share`** (order 95) — Web Share API with a clipboard + toast fallback. No
  platform-specific SDK.

Two existing sections changed:

- **`rates`** is now real data — one card per `ChronoStationGroup`, priced from
  `hourlyRate`, with `memberRate` as a sub-line on the same card. Its invented
  `DEFAULT_RATES` fallback was **deleted**, not merely unused: the venue-info
  fetch returns `null` on failure, so a default parameter would have fired on
  exactly the outage path and re-published fabricated prices. Groups whose
  `hourlyRate` is zero are dropped (the column is `notNull().default("0")`, so an
  unpriced group would otherwise advertise "₱0 / hr").
- **`specs` and `games` are now `defaultEnabled: false`.** Both render
  hardcoded, non-tenant-specific content ("Ryzen 7 class CPU", a fixed 8-title
  game list), which a venue's own site must not claim. They remain in
  `TENANT_SECTION_CHOICES`, so a tenant can still switch them on. The real fix
  is a tenant-editable `venue` block on `landingConfigSchema`; defaulting them
  off is the same honest stopgap `testimonials`/`events` already use.

### `GET /public/venue-info`

The one backend read behind the sections above
(`apps/chrono-api/src/modules/branch/routes.ts`, mounted in `app.ts` alongside
the other `/public/*` routes). It exists so `/public/stations` — a focused,
already-audited route — did not have to grow, matching this app's existing
one-small-route-per-concern convention (`/public/tenant`, `/public/branding`,
`/public/stations`, `/public/landing-page`).

It returns the tenant's **first active branch** (oldest by `createdAt`) contact /
social / maps fields, plus that branch's station groups' `hourlyRate` /
`memberRate`. Multi-branch public data is not modelled yet.

It follows the "Unauthenticated routes" conventions above exactly: rate-limited
`createRateLimiter(20, 60 * 1000, "public-venue-info")` — the same numbers as
`publicStationsLimiter`, a marketing page rather than a money-moving route;
tenant resolved server-side via `resolveOrgFromRequest` and never from client
input; terminal lifecycle statuses refused with a 404; and an explicit column
allowlist, never a raw row.

**Isolation model:** it serves exactly one host-resolved tenant, so it reads
through `withTenant` (RLS-enforced) — **not** `withAdmin`, unlike
`readPublishedLandingPage`. A tenant with no active branch yet is a normal 200
carrying `{ branch: null, rateGroups: [] }`; a public page must not dead-end on
an unfinished setup. Browser-level proof lives in
`apps/chrono-web/e2e/tests/venue-info/cross-tenant-isolation.spec.ts`.

### Theme presets

`apps/chrono-web/src/lib/theme-presets.ts` registers Chrono's palettes through
the foundation's `buildThemePresetRegistry`. `elegant-gold` is the default and
its values already ship in `app/globals.css`, so `themePresetCss()` emits
nothing for it and the stylesheet stays the real fallback.

**Every new palette must clear WCAG AA before merging**: 4.5:1 for text pairs,
and 3:1 for any non-text role that carries meaning — `ring` above all, since it
is the focus indicator. `neon-green` uses `#0f7a3d` rather than the brighter
`#22c55e` for exactly this reason (that measures 2.21:1 on `background`). Method
and worked examples: `.ai/plans/chrono/archive/chrono-theme-colors/palette-source.md`.

A tenant's own `primaryColor`/`accentColor` (branding settings) **beat** their
preset, because `brandingCss()` is injected after the preset `<style>`. Note it
emits no `.dark` variant, so a brand colour applies identically in both modes
rather than resolving per-mode.

### The brand lockup

`components/landing/chrono-brand.tsx` — owl mark (`public/brand/chrono-owl.png`)
plus the wordmark in `font-chrono` (**Bruno Ace SC**, loaded via `next/font` in
`app/layout.tsx`, mapped to the token in `@theme inline`). Both `.premium-*`
utilities and the wordmark's gradient follow `var(--primary)`, so a preset or a
tenant brand colour retints the whole surface with no component change.

The owl is the **marketing** default only. A tenant with a logo gets it through
`BrandHeader`; never hardcode the owl on a branded tenant's page.

### Draft and publish

`draft` and `published` are separate snapshots. The editor writes `draft`;
`/public/landing-page` returns `published` only. So **editing a live page changes
nothing publicly until Publish is pressed** — a single row plus an `isPublished`
boolean would gate only the first publish and let every later save go straight
out. Unpublish clears `published` and keeps `publishedAt` as the last-published
marker.

Publish and unpublish each write one audit row. The public read uses `withAdmin`
and therefore **bypasses RLS** — its explicit `tenantId` filter is the only
isolation on that path, so `rls:proof` does not cover it and the cross-tenant
e2e case is the real proof.

### Legacy columns

`ChronoLandingPages`' six original content columns are still read, as the
*lower-precedence* layer of the config cascade
(`apps/chrono-web/src/lib/landing.ts`), so a tenant who configured a page before
this feature keeps their content and anything set in the new editor wins.
Dropping those columns is a later cleanup, once the new path is proven.
