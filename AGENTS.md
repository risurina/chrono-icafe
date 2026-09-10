# Chrono iCafe — Agent Context

Single source of truth for every AI coding assistant on this repo. Claude Code reads
`CLAUDE.md`, which points here.

`chrono-icafe` is a standalone repo for **Chrono**, a gaming/internet-café
venue-management SaaS product: branches (venue locations) run stations (PC gaming
seats) with paired kiosk devices; customers hold a wallet/credit balance and run timed
sessions on a station; staff work shifts. Loyalty, vouchers, promos, POS, reservations,
reporting/reconciliation, security alerts, QR flows, and inquiries sit on top of that
spine. See `apps/chrono-api/AGENTS.md` for Chrono's full product/domain context, status,
and module-by-module detail.

This repo was extracted (with git history preserved) from a shared monorepo,
`risurina/agora`. The multi-tenant foundation that repo owns (`packages/agora`, `apps/
agora-api`, `apps/agora-web`) is consumed here as a **git submodule** pinned to a tagged
release, not vendored source — see "Foundation submodule" below.

## Workspace layout

- `apps/chrono-api` — Hono API: `/auth/*` (Better Auth) + `/rpc/*` (typed) + tenant→RLS
  context; owns Chrono's own schema (`src/db/schema.ts` + `APP_TENANT_TABLES`) and every
  business module under `src/modules/<domain>/`.
- `apps/chrono-web` — Next.js App Router UI (dashboard + portal + apex marketing).
- `apps/chrono-docs` — product documentation.
- `packages/agora` — **git submodule**, the entire `risurina/agora` monorepo. The real,
  importable `agora` package (with its `exports` map) lives one level deeper, at
  `packages/agora/packages/agora/` — see "Foundation submodule" below before touching
  anything under `packages/agora/`.

## Foundation submodule — read this before editing workspace/tooling config

`packages/agora/` is the ENTIRE `risurina/agora` repo checked out at a pinned tag,
including its own nested `packages/agora/` (the real package), its own `apps/agora-api`/
`apps/agora-web` reference scaffold, its own `.ai/rules/`, its own root `AGENTS.md`, and
its own root `package.json` (also named `"agora"` — that's the monorepo-root manifest,
not the importable package).

- The root `pnpm-workspace.yaml` therefore points at the package **explicitly**
  (`packages/agora/packages/agora`), not a bare `packages/*` glob — a bare glob would
  make pnpm discover both the submodule's own root manifest and the real nested package
  (both named `"agora"`) and collide.
- Never edit anything under `packages/agora/` directly — it is a pinned, read-only
  foundation checkout. A foundation change is made in `risurina/agora`, released as a new
  tag, then this submodule is bumped (`cd packages/agora && git fetch --tags && git
  checkout <new-tag>`, then commit the updated gitlink) — never by hand-patching files
  inside the submodule from this repo.
- Chrono's own module contracts, permissions, feature flags, and modules are registered
  through the foundation's documented extension seams (see
  `packages/agora/.ai/rules/business-app.md`, "Extension seams") — never by editing
  `packages/agora/packages/agora/src/**` directly.

## Foundation rules that still apply

Every foundation rule (tenant isolation, RBAC, DTO/contracts, component-first UI, e2e
coverage, database/RLS discipline) applies to Chrono exactly as it applies to the
`agora` scaffold. Read the submodule's own rules docs for the authoritative source —
they are not duplicated here:

- `@packages/agora/.ai/rules/README.md`
- `@packages/agora/.ai/rules/ai-agent.md`
- `@packages/agora/.ai/rules/architecture.md`
- `@packages/agora/.ai/rules/business-app.md`
- `@packages/agora/.ai/rules/monorepo.md`
- `@packages/agora/.ai/rules/tenant.md`
- `@packages/agora/.ai/rules/database.md`
- `@packages/agora/.ai/rules/api.md`
- `@packages/agora/.ai/rules/auth.md`
- `@packages/agora/.ai/rules/rbac.md`
- `@packages/agora/.ai/rules/providers.md`
- `@packages/agora/.ai/rules/ui.md`
- `@packages/agora/.ai/rules/styling.md`
- `@packages/agora/.ai/rules/dto.md`
- `@packages/agora/.ai/rules/json-render.md`
- `@packages/agora/.ai/rules/modules.md`
- `@packages/agora/.ai/rules/testing.md`
- `@packages/agora/.ai/rules/e2e-testing.md`
- `@packages/agora/.ai/rules/feature-planning.md`
- `@packages/agora/.ai/rules/implementation.md`
- `@packages/agora/.ai/rules/component-first-ui.md`
- `@packages/agora/.ai/rules/pagination.md`
- `@packages/agora/.ai/rules/admin-table.md`
- `@packages/agora/.ai/rules/data-listing.md`
- `@packages/agora/.ai/rules/stories.md`

Chrono-specific context (product detail, current build status, per-module notes) lives
in `apps/chrono-api/AGENTS.md` — read it next.

## Chrono's own modules

`apps/chrono-api/src/modules/`: `activity`, `app-usage`, `branch`, `business-lead`,
`company-inquiry`, `credit`, `device`, `inquiry`, `landing-page`, `loyalty`, `member`,
`onboarding`, `payment`, `pos`, `promo`, `qr`, `realtime`, `reconciliation`, `report`,
`reservation`, `security-alert`, `session`, `shift`, `station`, `voucher`, `wallet`,
`webhook`.

## Working Rules

- Use `pnpm`.
- Plan-first for features/schema/architecture changes
  (`packages/agora/.ai/rules/feature-planning.md`); read the plan before implementing
  anything plan-driven. This repo's own plan history lives at `.ai/plans/chrono/**`.
- Implement one phase at a time; commit each finished phase separately.
- No AI/agent attribution in commits, PRs, code, or docs. Author as the human developer.

## Commands

`pnpm dev` (chrono-api :8787 + chrono-web :3000) · `pnpm typecheck` · `pnpm build` ·
`pnpm format` · `pnpm db:generate --name <x>` + `pnpm db:migrate` · `pnpm db:push`
(local only) · `pnpm db:seed` · `pnpm db:app-role` · **`pnpm db:rls:proof`** (prove
tenant isolation after any tenancy/RLS/schema change — must print `RLS PROOF: PASS ✅`)
· `pnpm test:e2e`.

## Before you finish

`pnpm typecheck` passes · touched tenancy/RLS/schema → `pnpm db:rls:proof` passes · new
tenant table is in `APP_TENANT_TABLES` and migrated · new/changed tenant-scoped feature
ships an e2e spec (happy path + role gate + cross-tenant isolation) · mutations
role-gated + Zod-validated · no secrets committed.
