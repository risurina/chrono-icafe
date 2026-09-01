# Chrono — Agent Context

Read this after the root `AGENTS.md` and `.ai/rules/*` — this file only covers what's
specific to Chrono. It documents the `apps/chrono-api` + `apps/chrono-web` pair (one doc
for both, see `.ai/rules/business-app.md`, "Where rules live").

Chrono is a business app built on the Agora foundation (`.ai/rules/business-app.md`,
`.ai/rules/architecture.md` "Business Apps"). Every foundation rule (tenant isolation,
RBAC, DTO/contracts, component-first UI, e2e coverage) applies to Chrono exactly as it
applies to the scaffold — nothing here overrides them.

## Status

Migrating from an existing implementation as of 2026-09-01. `apps/chrono-api` /
`apps/chrono-web` are currently a byte-identical clone of `apps/agora-api` /
`apps/agora-web` (package names already renamed to `@agora/chrono-api` /
`@agora/chrono-web`) — no business-specific schema, routes, or pages have landed yet.

## Business domain

Chrono is a gaming/internet-café venue-management product: branches (venue locations)
run stations (PC gaming seats) with paired kiosk devices; customers hold a wallet/credit
balance and run timed sessions on a station; staff work shifts. Loyalty, vouchers,
promos, POS, reservations, reporting/reconciliation, security alerts, QR flows, and
inquiries sit on top of that spine.

**Source**: an existing mature implementation at
`C:\Users\ronni\project\izur\oikos` (`apps/chrono-api` + `apps/chrono-web` +
`packages/chrono`, built on a sibling foundation `@risurina/oikos`) is being migrated
into this Agora-based pair, adapting to Agora's tenant/RLS/RBAC/DTO conventions rather
than copied verbatim. Watch for the old implementation's own foundation-vs-business
boundary mistakes before repeating them here (e.g. a prior bespoke member system that
should have reused the foundation's tenant member pool instead of forking it).

## Modules

**Wave 1 (this migration pass)** — the operational spine, in dependency order:
`branches` → `stations` → `devices` (kiosk pairing/auth) → `members` (customer pool) →
`sessions` → `shifts` → `wallet`/`credits`. Each lands under
`apps/chrono-api/src/modules/<domain>/` per `.ai/rules/business-app.md`.

**Deferred (later waves, not in this pass)** — `loyalty`, `vouchers`, `promos`, `pos`,
`reservations`, `reports`, `reconciliation`, `security-alerts`, `qr`, `inquiries`,
`onboarding-checklist`, `app-versions`, `app-usage`, `public-stations`,
`public-releases`, `tenant-landing`, `admin-station-client`. Present in the source
implementation; not planned until Wave 1 is proven.

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
