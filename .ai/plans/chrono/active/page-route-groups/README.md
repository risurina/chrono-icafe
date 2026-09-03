# Plan — Group `apps/chrono-web/src/app` into 5 Route Groups

Status: **Draft** (not yet accepted — do not implement)
App: `chrono` (business app, mirroring a foundation convention)
Type: internal reorganization only — Next.js route groups (`(name)/`) are excluded from
the URL, so no route path, response shape, or public behavior changes anywhere in this
plan.

Depends on: `.ai/plans/agora/active/page-route-groups/README.md` landing first —
`apps/chrono-web` was cloned from `apps/agora-web` (`.ai/rules/business-app.md`), and
this plan mirrors that plan's grouping exactly for every page the two apps share,
extending it only for the pages that are genuinely chrono-only.

Also depends on: `.ai/plans/chrono/active/unified-customer-portal/README.md` landing
first. That plan merges `apps/chrono-web/src/app/customer/*` into `/portal/*` (a
host-aware single route — apex renders the global customer identity, a tenant host
renders the existing tenant-scoped portal), so by the time this plan runs, `customer/`
no longer exists as a separate top-level folder. This plan's file lists below already
reflect that — `customer/` is not one of the items moved here.

## Motivation

`apps/chrono-web/src/app` has the same 13 flat top-level items the agora-web plan
addresses, **plus** four more chrono-only additions that grew as flat siblings with
nowhere else to go: `about/`, `contact/`, `stations/` (+ its `api/public-stations/`
backend-for-frontend route), and `q/[token]/`. (A fifth chrono-only addition,
`customer/*`, is handled by the `unified-customer-portal` plan instead — it's folded
into `/portal/*` before this plan runs, so there's no `customer/` folder left to place
by the time this plan's phases execute.) Grouping the remaining set the same way keeps
chrono's file tree readable and keeps it in sync with the scaffold's own convention
instead of drifting further every time a new top-level page is added.

## Pass 1 — Workflow Analysis

- **Who is affected:** no end user or tenant — pure file/folder reorganization.
- **What workflow is enabled:** the same 5-surface mental model as agora-web, now also
  covering chrono's business-specific public/landing pages (`about`, `contact`,
  `stations`, `q/[token]`), instead of those growing as more ungrouped root-level
  clutter as future modules land (Chrono is mid-migration per
  `apps/chrono-api/AGENTS.md` — more top-level pages are still coming).
- **Failure cases to avoid:**
  - Same as the agora-web plan: no URL/behavior change, root layout stays a direct
    child of `app/`, group folder names never leak into a URL.
  - `q/[token]/page.tsx` is explicitly documented as reachable from **any** host (no
    tenant middleware — it re-anchors itself using the token, not the request host).
    Moving its folder must not be mistaken for giving it host-specific behavior it
    doesn't have; it lands in `(tenant-landing)` as an organizational choice (it's part
    of the tenant-facing QR/loyalty journey), not because it's bound to one tenant host.
  - `apps/chrono-web/src/app/api/public-stations/route.ts` is a same-origin proxy used
    only by `stations/client.tsx`'s polling (confirmed: its only caller is
    `fetch("/api/public-stations")` in that one file). Moving it must preserve the
    route path `/api/public-stations` exactly — Route Handlers follow the same
    route-group-is-invisible-in-the-URL rule as pages.
- **No tenant-isolation, RLS, schema, or permission impact.**

## Pass 2 — Technical Planning

### The 5 groups (mirrors the agora-web plan, extended for chrono-only pages)

| Route group | What lands here (chrono-only additions in **bold**) |
|---|---|
| `(saas-admin)` | `admin/` (unchanged subtree) |
| `(saas-landing)` | `page.tsx`, `auth/callback/`, `forgot-password/`, `login/` (+ `login/verify-mfa/`), `new-business/`, `reset-password/`, `sign-up/`, **`about/`**, **`contact/`** |
| `(tenant-admin)` | `dashboard/` (unchanged subtree) |
| `(tenant-landing)` | `accept-invite/`, `suspended/`, **`stations/`**, **`q/[token]/`**, **`api/public-stations/`** |
| `(member-portal)` | `portal/` (unchanged subtree) |

**Classification notes for the chrono-only additions** (decided with the developer
before writing this plan):

- `about/`, `contact/` are apex marketing pages → `(saas-landing)`, no different from
  `page.tsx` itself.
- `customer/*` is not listed here — see the `unified-customer-portal` plan, which folds
  it into `(member-portal)/portal/*` (host-aware) ahead of this plan.
- `stations/` (public station listing) and `q/[token]/` (QR scan-landing) are
  tenant-facing, non-marketing, pre-authentication content → `(tenant-landing)`,
  alongside `accept-invite/` and `suspended/`.
- `api/public-stations/route.ts` moves alongside `stations/` since it exists solely to
  serve that page's client-side polling — a Route Handler can live inside a route group
  exactly like a page.

### Files in scope

No page content changes anywhere in this plan — every change is a folder move
(`git mv`). `app/global-error.tsx`, `app/globals.css`, `app/layout.tsx`, and
`app/providers.tsx` stay exactly where they are, same reasoning as the agora-web plan.

### Out of scope

- Any sub-grouping inside `admin/`, `dashboard/`, or `portal/` themselves.
- Adding a new `layout.tsx` to any of the 5 groups.
- Any change to `apps/agora-web` (that's the companion plan, and must land first).
- Renaming any page, component, or export.
- Merging `customer/*` into `portal/*` — that's the `unified-customer-portal` plan,
  which must land before this plan's Phase 1 runs.
- Reconciling `customer/*`'s absence from the agora-web scaffold — a separate,
  unplanned decision, unaffected by either plan here.

### Risk notes

- Both phases are 100% mechanical, matching the agora-web plan's Jules-eligibility
  reasoning.
- `stations/` and `q/[token]/` sit on the customer-facing loyalty/QR flow — after the
  move, physically re-scan a real QR code (or hit `/q/<a-real-token>` from the DB) in
  addition to `pnpm build`, since this is the one route in this plan reachable from
  outside the normal apex/tenant host pattern and worth a real end-to-end check, not
  just a build pass.

---

## Phase 1 — Group the scattered apex/tenant-landing pages

**Files to update** (all `git mv`, no content edits)

- `apps/chrono-web/src/app/page.tsx` → `apps/chrono-web/src/app/(saas-landing)/page.tsx`
- `apps/chrono-web/src/app/about/` → `apps/chrono-web/src/app/(saas-landing)/about/`
- `apps/chrono-web/src/app/contact/` → `apps/chrono-web/src/app/(saas-landing)/contact/`
- `apps/chrono-web/src/app/auth/` → `apps/chrono-web/src/app/(saas-landing)/auth/`
- `apps/chrono-web/src/app/forgot-password/` → `apps/chrono-web/src/app/(saas-landing)/forgot-password/`
- `apps/chrono-web/src/app/login/` → `apps/chrono-web/src/app/(saas-landing)/login/`
- `apps/chrono-web/src/app/new-business/` → `apps/chrono-web/src/app/(saas-landing)/new-business/`
- `apps/chrono-web/src/app/reset-password/` → `apps/chrono-web/src/app/(saas-landing)/reset-password/`
- `apps/chrono-web/src/app/sign-up/` → `apps/chrono-web/src/app/(saas-landing)/sign-up/`
- `apps/chrono-web/src/app/accept-invite/` → `apps/chrono-web/src/app/(tenant-landing)/accept-invite/`
- `apps/chrono-web/src/app/suspended/` → `apps/chrono-web/src/app/(tenant-landing)/suspended/`
- `apps/chrono-web/src/app/stations/` → `apps/chrono-web/src/app/(tenant-landing)/stations/`
- `apps/chrono-web/src/app/q/` → `apps/chrono-web/src/app/(tenant-landing)/q/`
- `apps/chrono-web/src/app/api/public-stations/` → `apps/chrono-web/src/app/(tenant-landing)/api/public-stations/`

**Step-by-step tasks**

1. Confirm the current top-level inventory matches the list above:
   `find apps/chrono-web/src/app -maxdepth 2` (catch anything added since this plan
   was written — chrono is mid-migration, per `apps/chrono-api/AGENTS.md` — and confirm
   `customer/` is already gone, i.e. `unified-customer-portal` has landed).
2. `git mv` each item into its new group path exactly as listed above. `login/` carries
   `verify-mfa/`, and `q/` carries `[token]/`, automatically, as folder moves.
3. Grep `apps/chrono-web/src` and `apps/chrono-web/e2e` for any string literal or
   import referencing an old file-system path — expect no hits (pages/route handlers
   are reached by the router, not imported); treat any hit as real work, not noise.
4. `pnpm --filter @agora/chrono-web build`.
5. `pnpm dev`, then manually load each moved route: apex `/`, `/about`, `/contact`,
   `/login`, `/sign-up`, `/forgot-password`, `/reset-password`, `/new-business`; on a
   tenant subdomain:
   `{slug}.localtest.me:3000/accept-invite`, `.../suspended`, `.../stations`; and the
   API route `{slug}.localtest.me:3000/api/public-stations`. Confirm `/q/<token>` still
   resolves for a real token per the risk note above.

**Acceptance criteria**

- Every URL above resolves identically to before the move.
- No new `layout.tsx` was introduced.
- `pnpm --filter @agora/chrono-web build` succeeds.
- `pnpm typecheck` passes.

**Verification commands**

- `pnpm --filter @agora/chrono-web build`
- `pnpm typecheck`
- Manual spot-check per step 5 above.

**Out of scope**

- Phase 2's folder wraps (`admin/`, `dashboard/`, `portal/`).
- Any content/behavior change to a moved page or route handler.

**Execution start point**

- `apps/chrono-web/src/app/` top level.

**Jules-eligible:** yes — pure `git mv`, zero open decisions, verification stays local
per `.ai/rules/feature-planning.md`.

---

## Phase 2 — Wrap the already-cohesive folders

**Files to update** (all `git mv`, no content edits)

- `apps/chrono-web/src/app/admin/` → `apps/chrono-web/src/app/(saas-admin)/admin/`
- `apps/chrono-web/src/app/dashboard/` → `apps/chrono-web/src/app/(tenant-admin)/dashboard/`
- `apps/chrono-web/src/app/portal/` → `apps/chrono-web/src/app/(member-portal)/portal/`

**Step-by-step tasks**

1. `git mv apps/chrono-web/src/app/admin apps/chrono-web/src/app/"(saas-admin)"/admin`.
2. Repeat for `dashboard/` → `(tenant-admin)/dashboard/` and `portal/` →
   `(member-portal)/portal/`.
3. Confirm every nested `layout.tsx` (`admin/layout.tsx`, `dashboard/layout.tsx`,
   `dashboard/settings/layout.tsx`, `portal/layout.tsx`) moved with its parent and
   needs no edits.
4. `pnpm --filter @agora/chrono-web build`.
5. Manually load `/admin`, a tenant's `/dashboard`, and a tenant's `/portal`.

**Acceptance criteria**

- `/admin/*`, `{slug}.APP_DOMAIN/dashboard/*`, and `{slug}.APP_DOMAIN/portal/*` all
  resolve identically to before the move.
- No new `layout.tsx` was introduced.
- `pnpm --filter @agora/chrono-web build` succeeds.

**Verification commands**

- `pnpm --filter @agora/chrono-web build`
- `pnpm typecheck`
- Manual spot-check per step 5 above.
- If time allows: chrono's Playwright e2e suite, since this phase's blast radius is
  every admin/dashboard/portal route in one move.

**Out of scope**

- Any sub-grouping inside `admin/`, `dashboard/`, or `portal/`.

**Execution start point**

- `apps/chrono-web/src/app/admin/`, `dashboard/`, `portal/`.

**Jules-eligible:** yes — same reasoning as Phase 1.

---

## Final shape after both phases

```
apps/chrono-web/src/app/
  (saas-admin)/
    admin/...                     # unchanged subtree
  (saas-landing)/
    page.tsx
    about/
    contact/
    auth/callback/
    forgot-password/
    login/
      verify-mfa/
    new-business/
    reset-password/
    sign-up/
  (tenant-admin)/
    dashboard/...                 # unchanged subtree
  (tenant-landing)/
    accept-invite/
    api/
      public-stations/route.ts
    q/
      [token]/
    stations/
    suspended/
  (member-portal)/
    portal/...                    # unchanged subtree
  global-error.tsx
  globals.css
  layout.tsx
  providers.tsx
```

## CRUD & Feedback Contract

Not applicable — no new entity, mutation, or user-facing control. No new toasts,
errors, or audit events.

## Sequencing note

Do not start this plan's Phase 1 until both:
1. `.ai/plans/agora/active/page-route-groups/README.md` is fully implemented, verified,
   and committed — this plan's grouping decisions are inherited from that one, and
   implementing chrono first would risk the two apps diverging on naming if anything
   changes during the agora-web review.
2. `.ai/plans/chrono/active/unified-customer-portal/README.md` is fully implemented,
   verified, and committed — so `customer/` is already folded into `portal/` and this
   plan never has to place it.

Within this plan, Phase 1 before Phase 2, same reasoning as the companion plan.
