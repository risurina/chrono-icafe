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
- `session` — contracts + money helpers in progress; no schema/routes yet.
- `pos` and `reservation` landed ahead of their originally planned wave (`pos`: schema +
  contracts; `reservation`: schema, contracts, routes, web UI, e2e — plan archived at
  `.ai/plans/chrono/archive/reservations/README.md`). `reservation` has since gained a
  member self-service follow-up — direct booking, a queue/hold system, ban/restriction
  tracking, a per-tenant/branch policy, and a background sweep — API-side phases
  (schema, contracts, permissions, member portal routes, session-claim wiring, sweep)
  landed; member UI and e2e spec not yet built. See
  `.ai/plans/chrono/archive/reservations-queue-and-self-service/README.md` and
  `apps/chrono-docs/product/member-reservations.md`.

**Deferred (later waves, not in this pass)** — `loyalty`, `vouchers`, `promos`,
`reports`, `reconciliation`, `security-alerts`, `qr`, `inquiries`,
`onboarding-checklist`, `app-versions`, `app-usage`, `public-releases`,
`admin-station-client`. Present in the source implementation; not planned until Wave 1
is proven. `public-stations` and `tenant-landing` have since landed ahead of the rest of
this list — archived at `.ai/plans/chrono/archive/public-stations/README.md` and
`.ai/plans/chrono/archive/tenant-landing/README.md`.

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

- **`APP_DOMAIN/customer/*`** — apex-level sign-up/sign-in for the foundation's
  platform-wide global customer identity (`agora/customer-auth`, `customer` table,
  cookie `agora_customer`). Distinct from `{tenantSlug}.APP_DOMAIN/portal/*`'s
  tenant-only customer signup (`agora/member-auth`, `tenantMember`) — a global customer
  signs up once here, then self-service "applies" from a given tenant's `/portal`
  (`POST /portal/customer/apply`) to become a customer of that tenant. See
  `.ai/rules/business-app.md`, "Global customers", and
  `.ai/plans/agora/archive/global-customers/README.md`.
- **`{tenantSlug}.APP_DOMAIN/stations`** (verified custom domains resolve the same way)
  — public, unauthenticated live station-availability page (implemented:
  `.ai/plans/chrono/archive/public-stations/README.md`). Resolved via
  `getRequestTenant()` (`agora/next`) on the incoming host, exactly like the
  authenticated dashboard's own resolution — no session, no membership, no Next.js
  middleware. An unknown host or a tenant in a terminal lifecycle status
  (`suspended`/`cancelled`/`archived`/`deleting`) renders a 404, never stale or
  cross-tenant data.

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

## Landing pages

Chrono's public surfaces are the apex marketing page (`(saas-landing)/page.tsx`)
and each tenant's own landing page (`/about` on the tenant host). The **tenant**
page is fully configurable; the marketing page is not (its copy is Chrono's, not
a tenant's).

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
