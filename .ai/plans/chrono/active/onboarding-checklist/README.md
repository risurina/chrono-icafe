# Chrono — `onboarding-checklist` module

**Depends on:** `branches` (done), `stations` (schema done, routes pending — see Out of
Scope), `member` (done). **No dependency on:** `devices`, `sessions`, `shifts`,
`wallet`/`credits`, `pos`, `reservations`.

## What this is

A new-tenant setup checklist shown on the Chrono dashboard — "Create your first branch",
"Add a station", "Invite staff" — so a fresh Chrono owner/admin has a guided path instead
of a blank dashboard. It disappears once every item is complete or the tenant explicitly
dismisses it.

---

## Pass 1 — Workflow Analysis

**Who uses it:** the tenant `owner`/`admin` who just signed up and is setting up their
first branch/venue. `staff` may see it (read-only) but the actions it links to
(create branch, add station, invite staff) are gated the same way those actions already
are on their real pages — the checklist widget grants no new permission.

**Workflow:** on first login to `{slug}.APP_DOMAIN/dashboard`, a card renders above the
normal dashboard content listing 3 items with a live done/not-done state computed from
what already exists in the tenant (a branch row exists, a station row exists, more than
one `member` row exists). Each undone item links to the page that completes it. Once all
items are done, the card collapses to a slim "Setup complete" banner that can be
dismissed; dismissal is remembered per-tenant so it does not reappear.

**Failure cases:** unauthenticated → normal auth redirect, no special case. Wrong
tenant/host → normal `getRequestTenant()`/`tenantMiddleware()` handling, no special case.
A `member` role viewing the card: sees it, but clicking an item they lack permission for
(e.g. "Create branch" needs `branch:create`) lands them on the real page, which already
403s/hides the control — the checklist does not need its own gate beyond what the linked
pages already enforce. Stale screen: the "done" computation is a live read on every
dashboard load, not a cached snapshot, so it self-corrects if a branch is later deleted —
no invalidation bug to design around. Tenant-isolation leak: the computation must read
through `withTenant`/`c.var.tenant.tenantId` exactly like every other read — never a
cross-tenant count.

**Audit / notifications:** none. This is a low-stakes visibility widget, not a mutating
action — no audit event, no toast beyond whatever the linked pages already show on
success.

---

## Pass 2 — Technical Planning

### Foundation search result — no generic mechanism exists yet

`grep -ril "onboarding\|checklist" packages/agora/src` returns **no matches**. There is
no generic onboarding-checklist primitive in `packages/agora` today. This plan therefore
both designs the minimal generic piece and wires Chrono's three items into it — it does
not build a Chrono-only parallel system.

### Prior art (oikos, reimplementation reference only — do not port verbatim)

`apps/chrono-api/src/modules/onboarding-checklist/routes.ts` in the pre-Agora
implementation is a single `GET /` route with **no backing table at all** — it computes
3 hardcoded items on every read by querying `Branch`/`Station` existence directly, and
returns `{ items, completedCount, total, allDone }`. No persisted checklist-state row,
no per-tenant customization. The one thing it does *not* have that this plan adds is
per-tenant **dismissal** — oikos's version has no dismiss action; it re-appears every
time. That gap is deliberately fixed here since a permanently-recurring "finish setup"
card that already shows `allDone: true` is a UX regression, not a parity requirement.

### Decision — generic piece belongs in `packages/agora`, item definitions stay in Chrono

Per `AGENTS.md`'s rule of thumb ("if a second business app would need it too, it goes in
the foundation"): every future business app cloned from the scaffold will want a
first-run setup checklist shaped exactly like this one — compute a small ordered list of
`{key, label, done, href}` from tenant state, plus a per-tenant dismiss flag. That shape
has nothing Chrono-specific in it. So:

- **Foundation (`packages/agora`)**: a small **extension-seam registry**, following the
  exact pattern already proven by `module-registry.ts` / `feature-flags.ts`
  (`buildXRegistry(appItems)` merge function, a business app calls it once from its own
  contracts file) — not a new mutable table, not a scoring engine. The foundation owns:
  the `OnboardingChecklistItem` type (`{ key, label, description?, href, isComplete:
  (ctx) => Promise<boolean> | boolean }`), the merge helper, and the **one** piece of
  real state that must persist: per-tenant dismissal. Dismissal reuses the existing
  generic key/value pattern already proven for platform-global settings
  (`platform_setting`) but scoped per-tenant — concretely, the smallest correct option is
  a single boolean column on `organization` metadata is overkill for one flag; instead
  this plan adds one tiny tenant-scoped table, `TenantOnboardingDismissals` (mirrors
  `TenantNotifications`'s shape and lives beside it in the foundation schema), holding
  `tenantId` + `dismissedAt`. One row per tenant, ever. This is a foundation table
  (RLS-forced, `withTenant`) because dismissal-of-setup-checklist is exactly as generic
  as the checklist itself — a second business app dismisses the same way.
- **Chrono (`apps/chrono-api`)**: defines its own 3 `OnboardingChecklistItem`s (branch
  created, station added, staff invited) in a new `src/modules/onboarding/contracts.ts`,
  each `isComplete` a tiny tenant-scoped existence query, and composes them with
  `buildOnboardingChecklistRegistry([...])` in a Chrono-side registry file — identical
  shape to how `apps/chrono-api/src/auth/permissions.ts` composes `CHRONO_PERMISSION_
  STATEMENTS` over the foundation's via `registerAppPermissions()`. No new Chrono table.

### Pattern to copy

- Extension-seam merge function: `packages/agora/src/contracts/module-registry.ts`
  (`buildModuleRegistry`) — copy its shape exactly for
  `buildOnboardingChecklistRegistry`.
- Tenant-scoped table + route with no permission gate beyond tenant scoping: `shift`
  module's `GET /shifts/current` (`apps/chrono-api/src/modules/shift/routes.ts`) — a
  read that only needs `withTenant`, no `requirePermission` call, because it exposes
  nothing sensitive beyond what any tenant member already sees on the dashboard.
- Registration-time composition: `apps/chrono-api/src/auth/permissions.ts` +
  `auth-bootstrap.ts` (`registerAppPermissions` / `registerChronoPermissions`) — the
  onboarding registry composition follows the same "compose once, import first" idea,
  though it has no Better-Auth freeze hazard (it is a plain merge, not `agora/auth`), so
  it does not need the `auth-bootstrap.ts` import-order treatment — it is composed
  lazily inside the route handler instead.

### Schema — `TenantOnboardingDismissals` (foundation, `packages/agora/src/db/schema`)

```ts
export const tenantOnboardingDismissal = pgTable(
  "TenantOnboardingDismissals",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissedAt").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_onboarding_dismissal_tenant_idx").on(t.tenantId),
  ],
);
```

One row per tenant (unique on `tenantId`), upserted on dismiss. Added to the
**foundation's own tenant table set** (`BASE_TENANT_TABLES` if that split exists, else
directly into `apps/agora-api`'s `APP_TENANT_TABLES` composition and Chrono's, exactly
as every other foundation table already is) so RLS is forced in every app that imports
`agora/db/schema`.

### `APP_TENANT_TABLES`

Add `"TenantOnboardingDismissals"` to `apps/chrono-api/src/db/schema.ts`'s
`APP_TENANT_TABLES` array (it is a foundation table imported into Chrono's schema
composition, same treatment as `TenantNotifications`).

### Contracts

- `packages/agora/src/contracts/onboarding.ts`: `OnboardingChecklistItem` type,
  `OnboardingChecklistState` Zod schema (`{ items: [{key,label,description,href,done}],
  completedCount, total, allDone, dismissed }`), `buildOnboardingChecklistRegistry
  (appItems)`.
- `apps/chrono-api/src/modules/onboarding/contracts.ts`: `CHRONO_ONBOARDING_ITEMS`
  array (branch/station/staff), each with a resolver function signature
  `(tx, tenantId) => Promise<boolean>`.

### Routes

`apps/chrono-api/src/modules/onboarding/routes.ts`, composed into `routes/rpc.ts`:

- `GET /onboarding/checklist` — no `requirePermission` (read-only, tenant-scoped,
  visible to any authenticated member exactly like `/rpc/me`); runs each item's
  resolver inside a single `withTenant(tenantId, tx => ...)` call, reads the dismissal
  row, returns the computed state.
- `POST /onboarding/checklist/dismiss` — `requirePermission` is **not** appropriate here
  either (dismissing a UI card is not a privileged action; any member who can see the
  dashboard can hide it) — upserts the one dismissal row inside `withTenant`.

### Permission vocabulary

None added. This module deliberately introduces no new permission resource — see Pass 1
("the checklist widget grants no new permission").

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Checklist state | n/a (computed) | `GET /onboarding/checklist`, any authenticated member | n/a | n/a |
| Dismissal | `POST /onboarding/checklist/dismiss` (upsert), any authenticated member | folded into checklist read | re-dismiss is a no-op upsert | never deleted (no "un-dismiss" UI in MVP) |

No soft-delete concept applies (nothing is ever deleted). Feedback contract: dismissing
is optimistic-UI on the client (card collapses immediately); no toast needed for success,
a toast on failure ("Couldn't save — try again"). No audit event — not a sensitive
action.

### Web UI

`apps/chrono-web`: an `OnboardingChecklistCard` component in
`components/dashboard/onboarding/`, built from `agora/ui` `Card`/`Badge`/`Button`
primitives (per `.ai/rules/component-first-ui.md`), rendered at the top of
`app/dashboard/page.tsx` (or wherever the tenant dashboard root lives today) when
`!dismissed`. Uses the typed `/rpc` client, no local persisted state beyond a short
optimistic collapse.

### Out of Scope (this plan)

- Any checklist item beyond the three named (no "connect billing", no "verify domain").
- Per-role customization of which items a `staff` vs `owner` sees — everyone sees the
  same three.
- Undo/re-open after dismissal.
- Any admin/platform-side authoring UI for checklist items — items stay code-defined per
  app, exactly like `FEATURE_FLAGS`/`MODULE_REGISTRY` keys.
- Retrofitting the scaffold's own `apps/agora-web` dashboard to show this card — the
  generic *mechanism* ships in `packages/agora`, but wiring it into the neutral
  `agora-web` reference scaffold's UI is not requested and stays undone until a second
  business app actually needs the widget rendered (the scaffold keeps `project` as its
  only example; it is not required to demo every foundation primitive).

---

## Phase 1 — Foundation schema: `TenantOnboardingDismissals`

**Files to update**
- `packages/agora/src/db/schema/tenant.ts` (or nearest existing foundation schema file
  grouping tenant-scoped tables — inspect the file that already defines
  `tenantNotification`/`tenantUsageQuota` and add alongside it)
- `packages/agora/src/db/schema/index.ts` (barrel export, if one exists)
- `apps/agora-api/src/db/schema.ts` — add `"TenantOnboardingDismissals"` to
  `APP_TENANT_TABLES`
- `apps/chrono-api/src/db/schema.ts` — add `"TenantOnboardingDismissals"` to
  `APP_TENANT_TABLES`

**Step-by-step tasks**
1. Define `tenantOnboardingDismissal` table exactly as specified in Pass 2's schema
   block, in the foundation schema file.
2. Export it from the foundation schema barrel.
3. Add its table name to `APP_TENANT_TABLES` in both `apps/agora-api` and
   `apps/chrono-api` (it is a foundation table, so both apps that compose
   `agora/db/schema` must register it for RLS).
4. Run `pnpm db:generate --name add_tenant_onboarding_dismissals` and
   `pnpm db:migrate` against each app's own database (or a single shared migration if
   both apps share one Neon project — confirm against current chrono Neon project setup
   before generating).
5. Run `pnpm --filter @agora/api rls:proof` and `pnpm --filter @agora/chrono-api
   rls:proof` (or the single proof script if apps share one, per current chrono db
   tooling) to confirm forced RLS applies to the new table.

**Acceptance criteria**
- `TenantOnboardingDismissals` exists, RLS-forced, one row max per `tenantId`
  (unique index enforced at the DB level).
- `rls:proof` prints `RLS PROOF: PASS ✅` for every app that composes this table.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof` (and Chrono's equivalent if it has its own)

**Out of scope:** any Chrono-specific table — this phase touches only the foundation.

**Execution start point:** read the existing `tenantNotification` table definition first
to match its exact column/index style before adding the new table beside it.

---

## Phase 2 — Foundation contracts + registry seam

**Files to update**
- `packages/agora/src/contracts/onboarding.ts` (new)
- `packages/agora/src/contracts/index.ts` (barrel export, if present)

**Step-by-step tasks**
1. Define `OnboardingChecklistItem`, `OnboardingChecklistState` Zod schema, and
   `buildOnboardingChecklistRegistry(appItems)` mirroring `module-registry.ts`'s shape.
2. Export types via `z.infer`, never hand-duplicated.
3. Add a short unit test (co-located, per `.ai/rules/code-quality.md`) proving the merge
   function preserves foundation items and appends app items without collision.

**Acceptance criteria**
- `agora` contracts export includes the new onboarding types/registry builder.
- Unit test passes.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/agora test` (or whichever test script covers `packages/agora`
  unit tests — confirm exact script name before running)

**Out of scope:** any Chrono item definitions — foundation-only.

**Execution start point:** copy `packages/agora/src/contracts/module-registry.ts`
line-for-line as the starting structure, then adapt field names.

---

## Phase 3 — Chrono item definitions, routes, service

**Files to update**
- `apps/chrono-api/src/modules/onboarding/contracts.ts` (new)
- `apps/chrono-api/src/modules/onboarding/routes.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (compose `onboardingRoutes()`)

**Step-by-step tasks**
1. Define `CHRONO_ONBOARDING_ITEMS`: branch-created (query `chronoBranch` existence),
   station-added (query `chronoStation` existence), staff-invited (query `member` count
   > 1 via `adminDb`, filtered by `organizationId` — `member` is a foundation org table,
   not RLS-scoped, so this one resolver deliberately does **not** go through
   `withTenant`; it goes through `adminDb` filtered explicitly by `organizationId`,
   exactly as `.ai/rules/tenant.md` requires for foundation org tables).
2. Implement `GET /onboarding/checklist` and `POST /onboarding/checklist/dismiss` per
   Pass 2's Routes section — no `requirePermission` call on either, per the Permission
   vocabulary section above; both still resolve `c.var.tenant.tenantId` from
   `c.var.tenant`, never client input.
3. Compose `onboardingRoutes()` into `apps/chrono-api/src/routes/rpc.ts`.

**Acceptance criteria**
- `GET /onboarding/checklist` returns correct `done` flags against real tenant state in
  manual testing (create a branch → item flips to done on next fetch).
- `POST /onboarding/checklist/dismiss` persists and the next `GET` reflects
  `dismissed: true`.
- Cross-tenant isolation: tenant A's checklist never reflects tenant B's branches/
  stations/members.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** UI (Phase 4), e2e spec (Phase 5).

**Execution start point:** copy `apps/chrono-api/src/modules/shift/routes.ts`'s file
structure (imports, factory function shape, `withTenant` usage) as the starting
skeleton, then strip out everything permission-gated.

---

## Phase 4 — Web UI

**Files to update**
- `apps/chrono-web/src/components/dashboard/onboarding/onboarding-checklist-card.tsx`
  (new)
- `apps/chrono-web/src/app/dashboard/page.tsx` (or the actual tenant dashboard root —
  confirm exact path before editing)
- `apps/chrono-web/src/lib/rpc.ts` usage (typed client call, no new client needed if one
  already exists)

**Step-by-step tasks**
1. Build `OnboardingChecklistCard` from `agora/ui` primitives only (`Card`, `Badge`,
   `Button`) per `.ai/rules/component-first-ui.md` — no raw HTML chrome.
2. Fetch `GET /onboarding/checklist` on the dashboard page; render nothing if
   `dismissed`.
3. Wire the dismiss button to `POST /onboarding/checklist/dismiss` with optimistic
   collapse and a `toast.error(...)` on failure (`sonner`, per the UI rules table).

**Acceptance criteria**
- Card renders for a fresh tenant with 0/3 done, updates live as items complete, and
  disappears after dismiss with no page-reload flash.
- No raw `<div>`/`<button>` markup introduced in `apps/chrono-web`.

**Verification commands**
- `pnpm typecheck`
- `pnpm build`

**Out of scope:** any animation/illustration polish beyond the standard `Card` look.

**Execution start point:** read the existing tenant dashboard page first to find where a
top-of-page card slot already exists or needs adding.

---

## Phase 5 — E2E spec

**Files to update**
- `apps/chrono-web/e2e/tests/onboarding/onboarding-checklist.spec.ts` (new)

**Step-by-step tasks**
1. Happy path: sign up a fresh tenant, assert the card shows 0/3, create a branch via
   the real branches flow, reload, assert 1/3.
2. Role gate: not applicable as a distinct gate (no permission introduced) — instead
   assert a `member`-role user still sees the same card and can dismiss it (proving no
   accidental gate was added).
3. Cross-tenant isolation: create two tenants, complete an item in tenant A only, assert
   tenant B's checklist is unaffected.

**Acceptance criteria**
- All three scenarios pass under `pnpm test:e2e` (or the manual Playwright run per
  `.ai/rules/rbac.md`'s testing note, if this suite requires `pnpm dev` running).

**Verification commands**
- `pnpm --filter @agora/chrono-web test:e2e -- onboarding` (adjust to the actual e2e
  script name)

**Out of scope:** load/perf testing of the checklist read (it is a handful of cheap
existence queries, not a candidate for a dedicated perf test).

**Execution start point:** copy the nearest existing dashboard-flow spec's setup
(faker-based tenant creation) as the fixture.

---

## Open Questions (developer to confirm/override)

1. Does `packages/agora/src/db/schema` currently split foundation tables into multiple
   files (`tenant.ts`, `auth.ts`, …) with a barrel, or is everything still in one file?
   Confirm the exact file to add `tenantOnboardingDismissal` to before Phase 1.
2. Do `apps/agora-api` and `apps/chrono-api` currently point at separate Neon projects
   (separate migration histories) or a shared one? This determines whether Phase 1 is
   one migration or two.
3. Is there an existing `BASE_TENANT_TABLES` constant the foundation exports for apps to
   spread into their own `APP_TENANT_TABLES`, or does every app hand-list every
   foundation table it composes (as `apps/chrono-api/src/db/schema.ts` currently
   appears to)? This affects how "add to `APP_TENANT_TABLES`" is phrased in Phase 1.
4. Should `staff-invited` count `member` rows via `adminDb`+`organizationId` filter (as
   proposed) or is there already a helper for "does this tenant have >1 member" reused
   elsewhere that should be called instead of a fresh query?
5. Confirm the actual current path of the Chrono tenant dashboard root page for Phase 4
   (`apps/chrono-web/src/app/dashboard/page.tsx` is an assumption based on the scaffold's
   convention, not a verified path).

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/onboarding-checklist/` to
`.ai/plans/chrono/archive/onboarding-checklist/` once all 5 phases are verified and
committed, and update `.ai/handover/chrono-migration.md`'s deferred-modules list to drop
`onboarding-checklist` and its plan-status table to mark it done.
