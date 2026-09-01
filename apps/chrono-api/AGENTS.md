# Chrono — Agent Context

Read this after the root `AGENTS.md` and `.ai/rules/*` — this file only covers what's
specific to Chrono. It documents the `apps/chrono-api` + `apps/chrono-web` pair (one doc
for both, see `.ai/rules/business-app.md`, "Where rules live").

Chrono is a business app built on the Agora foundation (`.ai/rules/business-app.md`,
`.ai/rules/architecture.md` "Business Apps"). Every foundation rule (tenant isolation,
RBAC, DTO/contracts, component-first UI, e2e coverage) applies to Chrono exactly as it
applies to the scaffold — nothing here overrides them.

## Status

Starting from scratch as of 2026-09-01. `apps/chrono-api` / `apps/chrono-web` are
currently a byte-identical clone of `apps/agora-api` / `apps/agora-web` (package names
already renamed to `@agora/chrono-api` / `@agora/chrono-web`) — no business-specific
schema, routes, or pages exist yet.

## Business domain

TBD — not yet planned. Fill this in (what Chrono actually is, its module list, its
domain vocabulary) once the first feature is scoped, following `.ai/rules/
feature-planning.md`. Do not assume prior context about Chrono's product shape; none is
carried over.

## Modules

None yet. New domains go under `apps/chrono-api/src/modules/<domain>/` per
`.ai/rules/business-app.md`'s folder convention — update this list as they land.

## Surfaces

Inherited from the scaffold today (apex marketing/auth, `{slug}.APP_DOMAIN/dashboard/*`
tenant admin, `APP_DOMAIN/admin/*` platform admin). Whether Chrono needs its own
additional surface (e.g. a customer-facing `/portal/*`, distinct from tenant staff) is
part of the first feature's planning — don't assume one exists until it's built and
listed here.
