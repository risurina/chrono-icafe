# Chrono — tenant login paths (`/login`, `/admin/login`, `/admin/*`)

**Status: complete.** `apps/chrono-web` only, plus two optional props added to
`agora/ui` primitives (defaults keep the scaffold's behaviour unchanged).

## What this is

Chrono's tenant-facing URLs now match the reference site (`gaming.chrono.izur.com.ph`):

| On a tenant host (`{slug}.APP_DOMAIN`, or a verified custom domain) | Before | After |
| --- | --- | --- |
| Customer (member) sign-in → `/portal` | `/portal/login` | **`/login`** |
| Staff sign-in → the back office | apex-shaped `/login` (worked on any host, not tenant-scoped) | **`/admin/login`** |
| Tenant back office | `/dashboard/*` | **`/admin/*`** |

The apex is unchanged: `/login` is staff sign-in with no tenant context yet (org
selection / creation), `/portal/login` is the platform-wide global customer identity,
`/admin/*` is the platform admin.

## Decisions

1. **`/admin/*` is a `next.config.ts` host-based rewrite, not a folder rename.**
   `(saas-admin)/admin/*` already owns `/admin`, `/admin/billing`, `/admin/settings`,
   `/admin/security`, `/admin/reports`, `/admin/api-keys`, `/admin/webhooks` at the
   file-tree level, and App Router path resolution is host-agnostic — two `page.tsx`
   files cannot share a path. So the physical tree stays `(tenant-admin)/dashboard/*`
   and a `beforeFiles` rewrite with `missing: [{ type: "host", value: <apex hostname> }]`
   (plus `www.`) serves `/admin/:path*` from `/dashboard/:path*` on every non-apex host.
   This is config-level URL aliasing only — no `middleware.ts`, no request
   interception; tenant/auth enforcement is unchanged (layout session checks + API RLS).
   **Gotcha:** Next strips the port before matching `has`/`missing` host conditions,
   so the pattern is `localtest\.me`, never `localtest\.me:3000` — with the port the
   condition never matches and the rewrite fires on the apex too.
2. **`/admin/login` is rewritten separately onto `(tenant-admin)/staff-login`** so the
   login page sits outside `dashboard/layout.tsx`'s session gate (nested under it, an
   unauthenticated visitor would be redirected to the login page from the login page).
3. **`/login` is one host-branching page** (`(saas-landing)/login/page.tsx`): the member
   form on a tenant host, the staff form on the apex — the codebase's existing
   "renders everywhere, branches internally" pattern. A second `/login` page in another
   route group was tried first and is exactly the same collision as (1) (`You cannot
   have two parallel pages that resolve to the same path`); it 500'd every route in dev.
   The two forms are `src/components/member-login-form.tsx` / `staff-login-form.tsx`.
4. **Foundation seams instead of app-local copies:** `TenantSwitcher` gained
   `dashboardPath` (default `/dashboard`) and `UserMenu` gained `signOutHref` (default
   `/login`), because both hardcoded paths that now differ for Chrono (switching tenant
   must land on `/admin`; staff sign-out must not land on the member login).

## Files

- `apps/chrono-web/next.config.ts` — the two rewrites.
- `apps/chrono-web/src/app/(saas-landing)/login/page.tsx` — host branch.
- `apps/chrono-web/src/app/(tenant-admin)/staff-login/page.tsx` — new (tenant guard → `StaffLoginForm`).
- `apps/chrono-web/src/components/{staff,member}-login-form.tsx` — new; the member form
  moved from `(member-portal)/portal/login/tenant-login-form.tsx`.
- `apps/chrono-web/src/app/(member-portal)/portal/login/page.tsx` — apex/global only;
  tenant hosts redirect to `/login`.
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/layout.tsx` — `basePath="/admin"`,
  `TITLES` keys, unauthenticated → `/admin/login`, `TenantSwitcher dashboardPath`,
  `UserMenu signOutHref`.
- `apps/chrono-web/src/lib/post-auth.ts` — `resolveLandingUrl()` → `/admin[/setup]`.
- Every hardcoded `/dashboard` link/redirect under `(tenant-admin)/dashboard/**`,
  `components/settings-nav.tsx`, `(tenant-landing)/accept-invite`, `login/verify-mfa`
  (now uses `resolveLandingUrl()`); every tenant-side `/portal/login` redirect/link →
  `/login` (portal layout, QR page, tenant forgot/reset/sign-up/accept-invite forms,
  tenant landing chrome — whose Staff links → `/admin/login`).
- `packages/agora/src/presentation/ui/components/custom/{tenant-switcher,user-menu}.tsx`.
- `apps/chrono-api/AGENTS.md` — "Surfaces" rewritten.
- `apps/chrono-web/e2e/tests/**` — `/dashboard` → `/admin`, tenant staff sign-ins →
  `/admin/login`, tenant member sign-ins → `/login`, `startsWith("/login")` →
  `endsWith("/login")` (must hold for `/admin/login`); new
  `auth/tenant-login-paths.spec.ts` (staff path, member path, cross-tenant isolation).

## Verification

- `pnpm typecheck` (workspace) — passes.
- Live probe against `next dev` with `Host:` overrides: tenant `/admin/login` →
  `staff-login/page.tsx`; tenant `/admin`, `/admin/branches`, `/admin/settings/billing`
  → the `dashboard/*` tree; tenant `/login` → `(saas-landing)/login`; apex and `www.`
  `/admin`, `/admin/billing` → `(saas-admin)/admin/*`; apex `/admin/login` → 404.
- **Not run:** the Playwright suite (headed, manual, needs `pnpm dev`). The bulk path
  update to ~95 existing specs and the new spec are mechanical and unexecuted — run
  `pnpm --filter @agora/chrono-web e2e` before relying on them.

## Out of scope / follow-ups

- Other `/portal/*` pages (sign-up, forgot, reset, accept-invite, reservations,
  inquiries) keep their paths.
- `(saas-admin)/admin/layout.tsx` still sends a signed-in non-platform user on the apex
  to `/dashboard` (pre-existing; the apex has no tenant, so that was already a dead
  end) — a better target is `resolveLandingUrl()`.
- Root `README.md` documents the `apps/agora-web` scaffold (`/login` → `/dashboard`),
  which is unchanged, so it was left alone.
