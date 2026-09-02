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
`.ai/plans/chrono/active/*/README.md` for each module's exact phase status — some are
schema-only, others are through web UI + e2e). `sessions` is schema/contracts in
progress, not yet routed. `reservations` and `pos` (schema + Zod contracts) have also
landed ahead of the originally planned Wave 1 order. See each module's plan folder under
`.ai/plans/chrono/active/` (or `.ai/plans/chrono/archive/reservations/` once fully
closed) for the authoritative per-module status — this section is a snapshot, not the
source of truth.

## Business domain

Chrono is a gaming/internet-café venue-management product: branches (venue locations)
run stations (PC gaming seats) with paired kiosk devices; customers hold a wallet/credit
balance and run timed sessions on a station; staff work shifts. Loyalty, vouchers,
promos, POS, reservations, reporting/reconciliation, security alerts, QR flows, and
inquiries sit on top of that spine.

**Source**: an existing mature implementation at
`C:\Users\ronni\project\izur\oikos` (`apps/chrono-api` + `apps/chrono-web` +
`packages/chrono`, built on a sibling foundation `@risurina/oikos`) is **prior art, not a
spec.** This is a reimplementation on the Agora foundation, not a faithful port — oikos
shows what the product needs to do, not how every detail must be built. Default to
improving on oikos wherever its design is weak (dead/unused schema, missing constraints,
awkward naming, no transactional atomicity, a workaround for a problem Agora's
architecture doesn't have) rather than replicating it out of inertia. Match oikos's
behavior only where it's genuinely the right call or the developer asks for parity —
never as the default. Watch for the old implementation's own foundation-vs-business
boundary mistakes before repeating them here (e.g. a prior bespoke member system that
should have reused the foundation's tenant member pool instead of forking it — already
corrected, see `.ai/plans/chrono/active/members/README.md`).

Every landed plan under `.ai/plans/chrono/active/*/README.md` already exercises this
judgment in places (see each plan's "deliberate differences from oikos" notes), but each
also leaves some "match oikos or diverge" calls as open questions for the developer.
Resolve those through this lens — lean toward the improvement, not toward parity — unless
there's a concrete reason to keep oikos's behavior.

## Modules

**Wave 1 (this migration pass)** — the operational spine, in dependency order:
`branches` → `stations` → `devices` (kiosk pairing/auth) → `members` (customer pool) →
`sessions` → `shifts` → `wallet`/`credits`. Each lands under
`apps/chrono-api/src/modules/<domain>/` per `.ai/rules/business-app.md`. Current state
(see each `.ai/plans/chrono/active/<module>/README.md` for the authoritative phase-by-
phase status):

- `branch`, `station`, `member` (`ChronoMemberProfiles`), `shift` — schema + routes +
  permission gates landed; web UI landed for stations/shifts.
- `device` — schema + RLS landed (kiosk pairing/bearer-auth routes not yet built).
- `payment` — schema + routes + permission gates landed; web UI + e2e landed.
- `wallet` — schema + RLS landed (routes not yet built).
- `session` — contracts + money helpers in progress; no schema/routes yet.
- `pos` and `reservation` landed ahead of their originally planned wave (`pos`: schema +
  contracts; `reservation`: schema, contracts, routes, web UI, e2e — plan archived at
  `.ai/plans/chrono/archive/reservations/README.md`).

**Deferred (later waves, not in this pass)** — `loyalty`, `vouchers`, `promos`,
`reports`, `reconciliation`, `security-alerts`, `qr`, `inquiries`,
`onboarding-checklist`, `app-versions`, `app-usage`, `public-releases`,
`admin-station-client`. Present in the source implementation; not planned until Wave 1
is proven. `public-stations` and `tenant-landing` are now actively planned (see
`.ai/plans/chrono/active/`), ahead of the rest of this list.

**Out of scope for this pass** — `apps/chrono-mobile`, `apps/chrono-pc-client` (+
`-service`, `-tauri`), `apps/chrono-docs` from the source implementation. This pass is
`apps/chrono-api` + `apps/chrono-web` only; the API still needs to support device
pairing/bearer-auth (stations depend on it) even though the PC-client apps themselves
aren't being ported yet.

## Surfaces

Inherited from the scaffold today (apex marketing/auth, `{slug}.APP_DOMAIN/dashboard/*`
tenant admin, `APP_DOMAIN/admin/*` platform admin). Whether Chrono needs its own
additional surface (e.g. a customer-facing `/portal/*`, distinct from tenant staff) is
part of the first feature's planning — don't assume one exists until it's built and
listed here.

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
  `.ai/plans/chrono/active/public-stations/README.md`). Resolved via
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

See `.ai/plans/chrono/active/security-hardening/README.md` Phase 2 for the full
reasoning (the rate-limiting gap found across the `devices`/`qr`/`inquiries`/
`public-stations` plans was one convention gap, not four separate bugs).
