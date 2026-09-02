# Chrono — `onboarding-checklist` module

**Depends on:** `branches` (done), `stations` (schema done, routes pending — see Out of
Scope), `member` (done). **No dependency on:** `devices`, `sessions`, `shifts`,
`wallet`/`credits`, `pos`, `reservations`.

## What this is

A new-tenant setup checklist shown on the Chrono dashboard — seven items across three
stages, from "Create your first branch" through "Open your first shift" — so a fresh
Chrono owner/admin has a guided path instead of a blank dashboard. It disappears once
every item is complete or the viewer dismisses it.

It is the **passive** half of a pair: this card answers "what's left?", while the
`onboarding-wizard` plan's `/dashboard/setup` answers "do it now". Both render the one
item registry defined here — see "A single resolver is a deliverable of this plan".

---

## Pass 1 — Workflow Analysis

**Who uses it:** the tenant `owner`/`admin` who just signed up and is setting up their
first branch/venue. `staff` see the same seven items with the same progress count, but
four of them render as non-actionable ("Ask an admin") rather than links — see
"Permission vocabulary — corrected". The widget adds no permission of its own; every
linked action keeps the gate it already has.

**Workflow:** on first login to `{slug}.APP_DOMAIN/dashboard`, a card renders above the
normal dashboard content listing the seven items with a live done/not-done state computed
from what already exists in the tenant. Each undone, actionable item links to the step
that completes it. Once all items are done, the card collapses to a slim "Setup complete"
banner that can be dismissed; dismissal is remembered **per user** so it does not
reappear for that person (and does not silently remove a colleague's card).

**Failure cases:** unauthenticated → normal auth redirect, no special case. Wrong
tenant/host → normal `getRequestTenant()`/`tenantMiddleware()` handling, no special case.
A `staff` role viewing the card: sees all seven with the same progress, but the four they
cannot action are greyed rather than linked, so they are never sent to a page that will
403 them. This is display-only; the linked routes keep their own gates regardless. Stale screen: the "done" computation is a live read on every
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
both designs the minimal generic piece and wires Chrono's seven items into it — it does
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

> **Source-access note (2026-09-02 review).** The oikos tree lives at
> `C:\Users\ronni\project\izur\oikos` (the Windows machine); it is **not** checked out on
> the macOS machine, where `~/projects/karta/karta-oikos` is an empty stub. The oikos
> summary above is therefore carried forward from the original planning session and was
> **not** re-verified in this review. Everything below the "Resolved open questions"
> section *was* verified directly against this repo. If oikos's checklist needs a fresh
> read (e.g. to confirm the exact item set), do it from the Windows machine.

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
  real state that must persist: **per-user** dismissal (see "Dismissal is a tenant-wide
  write" below for why per-user, not per-tenant). This plan adds one tiny tenant-scoped
  table, `TenantOnboardingDismissals`, holding `tenantId` + `userId` + `dismissedAt`.
  It is a foundation table (RLS-forced, `withTenant`) because
  dismissal-of-setup-checklist is exactly as generic as the checklist itself — a second
  business app dismisses the same way.

  **Why a table and not a column — stated explicitly, because a reviewer will ask.**
  The cheapest-looking option is a nullable `onboardingDismissedAt` column on
  `tenantBranding` (`packages/agora/src/db/schema/tenant.ts:65-94`): it is already the
  foundation's one-row-per-tenant table, already RLS-registered in both apps, already has
  an upsert path — one migration, zero new tables. **Rejected**, for two reasons: (a)
  `tenantBranding` is presentation *configuration a tenant authors*, while this is
  ephemeral per-viewer UI state — overloading it makes the table mean two unrelated
  things; and (b) decisively, the per-user scoping resolved below needs a `userId`
  dimension that a one-row-per-tenant table cannot express without denormalising. The
  column option dies on (b) regardless of how one feels about (a).

  `tenantFeatureFlag` (`tenant.ts:102`) is **not** an alternative and should not be
  reached for: it stores per-tenant overrides of *code-defined flag keys*, not
  tenant-authored state.
- **Chrono (`apps/chrono-api`)**: defines its own `OnboardingChecklistItem`s (the
  seven-step set below, superseding the original three) in a new
  `src/modules/onboarding/contracts.ts`,
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
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissedAt").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_onboarding_dismissal_tenant_user_uq").on(t.tenantId, t.userId),
    index("tenant_onboarding_dismissal_tenant_idx").on(t.tenantId),
  ],
);
```

One row per (tenant, user), upserted on dismiss. Note **both** indexes: the composite
unique enforcing one dismissal per viewer, **and** the plain `*_tenant_idx` that
`.ai/rules/database.md` requires on every tenant-scoped table — the cited precedent
`tenantBranding` carries both (`tenant.ts:92-93`), and an earlier draft of this plan
listed only the unique. **There is no
`BASE_TENANT_TABLES` constant** (verified — the name appears only inside `platform.ts`
doc comments); every app hand-lists every table it wants RLS-forced. So the name is added
to `APP_TENANT_TABLES` in `apps/agora-api/src/db/schema.ts` **and**
`apps/chrono-api/src/db/schema.ts`, exactly as `TenantSecurityPolicies` /
`TenantIntegrations` / `TenantUsageQuotas` already are in both.

**Placement + precedent (corrected).** The table goes in
`packages/agora/src/db/schema/tenant.ts` (exported through the `index.ts` barrel via
`export * from "./tenant"`). The precedent to copy is `tenantBranding`
(`tenant.ts:65`, `uniqueIndex("tenant_branding_tenant_uq").on(t.tenantId)`) or
`tenantSecurityPolicy` (`tenant.ts:489`) — both are foundation, tenant-scoped,
exactly-one-row-per-tenant tables with a `*_tenant_uq` unique index. Follow their index
naming: `tenant_onboarding_dismissal_tenant_uq`, not `…_idx` as the block above spells
it (a `uniqueIndex` named `_idx` misleads every later reader).

Do **not** copy `tenantNotification` as the model, as an earlier draft of this plan said:
it is *not* a foundation table. It is defined app-side and duplicated in both
`apps/agora-api/src/db/schema.ts` and `apps/chrono-api/src/db/schema.ts:170` — the wrong
shape for something this plan explicitly wants shared.

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

### The item set — seven steps, three stages (supersedes the original three)

Verified against the real routes in `apps/chrono-api/src/modules/*/routes.ts` and the
real grants in `apps/chrono-api/src/auth/permissions.ts`:

Every row below was re-verified against the real gates and grants in an audit pass; the
`href`, probe, and permission are all registry fields (see A1/E5 below), so plan B changes
data, never a component.

| # | Stage | Item | Completion probe | Action route + gate | staff? |
|---|---|---|---|---|---|
| 1 | Venue | Create your first branch | `chronoBranch` exists | `POST /rpc/branches` — `branch:create` (`branch/routes.ts:90`) | ✗ |
| 2 | Venue | Add a station group | `chronoStationGroup` exists | `POST /rpc/stations/groups` — `station:create` (`station/routes.ts:184`) | ✓ |
| 3 | Venue | Add a station | `chronoStation` exists | `POST /rpc/stations` — `station:create` (`station/routes.ts:304`) | ✓ |
| 4 | Team | Invite a staff member | `member` count > 1 **OR** a pending `invitation` row exists (both `adminDb`, by `organizationId`) | `POST /rpc/invites` — `staff:["invite"]` (`packages/agora/src/invites/routes.ts:50`) | ✗ |
| 5 | Trading | Add POS products | `chronoProduct` exists | `POST /rpc/pos/products` — `pos:manageProducts` (`pos/routes.ts:99`) | ✗ |
| 6 | Trading | Create a device pairing code | `chronoDeviceProvisioningToken` exists | `POST /rpc/devices/provisioning-tokens` — `device:manage` (`device/routes.ts:216`) | ✗ |
| 7 | Trading | Open your first shift | `chronoShift` exists | `POST /rpc/shifts/open` — `shift:open` (`shift/routes.ts:120`) | ✓ |

**Two probe corrections that a naive reading gets wrong — both would have shipped a step
that can never turn green:**

- **Item 4** creates an **`invitation`** row, but a `member` row only appears when the
  invitee *accepts*. Probing `member` count alone leaves an owner who invited their whole
  team staring at a red step indefinitely. Hence the `OR pending invitation` clause. Both
  are foundation org tables → `adminDb` filtered by `organizationId`, never `withTenant`.
- **Item 6** originally probed `chronoDevice`. But a `chronoDevice` row is inserted **only**
  at `device/routes.ts:540`, inside the **unauthenticated** `POST /pair` handler driven by
  real hardware presenting a pairing code. Nothing an admin does in the dashboard creates
  one. The only action a human can take is minting a provisioning token — so the probe and
  the label both move to that. (This is not the same as "the hardware hasn't arrived yet";
  the probe was simply watching a different object than the action produced.)

Rationale for the growth from three to seven: the original set (1, 3, 4) leaves a tenant
that has "completed setup" still unable to trade — no products to sell, no device on the
floor, no open shift. Steps 2, 5, 6, 7 are the difference between a configured tenant and
an operating one. Stage grouping keeps a seven-item list from reading as a wall.

### Permission vocabulary — corrected

**No new permission resource is added** (that part of the original plan stands: the
checklist reads nothing sensitive, and dismissal is not privileged). But the original
plan's follow-on claim — that everyone sees the same items and the widget needs no
permission awareness — **does not survive the real grants**. Per the table above, a
`staff` user cannot action **four of the seven** steps — items 1, 4, 5, 6 (`branch`,
`pos:manageProducts` and `device` are all absent from `CHRONO_STAFF_GRANTS`, and
`staff:["invite"]` is a foundation grant staff does not hold). Handing that user an undone
to-do list that 403s on click is a
worse experience than the blank dashboard this feature exists to replace.

So the checklist becomes **permission-aware for display only**:

- The `GET` response adds a per-item `actionable: boolean`, computed from
  `c.var.tenant.permissions` via `hasPermission(...)` — the resolved set, never the role
  name (`.ai/rules/rbac.md`).
- A non-actionable, not-yet-done item renders greyed with "Ask an admin" instead of a
  link. It still counts toward `total`, so progress means the same thing for everyone.
- This is **visibility only** and is not a security boundary — the linked pages keep
  their own `requirePermission` gates, exactly as `<Can>`/`can()` are specified to work.
  A hidden-but-permitted control still works; a shown-but-denied one still 403s.

This costs no new statement and no new gate — it reuses `hasPermission` against the set
already resolved on every request.

### Dismissal is a tenant-wide write — resolved

Original text called dismissal "not privileged". That was wrong in a way worth naming: the
dismissal row is per-**tenant**, there is no un-dismiss path (explicitly out of scope), and
no audit event — so any `staff` account could permanently delete the owner's setup card for
the entire workspace with one ungated POST, unrecoverably.

**Resolution: scope dismissal per-user, not per-tenant.** The table becomes
`(tenantId, userId)` unique, and the checklist reads the row for
`c.var.tenant.userId`. This keeps dismissal genuinely unprivileged (you may only hide your
own card), removes the need for a gate or an audit event, and removes the
irreversibility problem — another admin's card is untouched. It also makes the widget
behave the way every dismissible UI a user has met behaves.

Rejected alternatives: gating it on a permission (dismissing your own card is not an
admin action); shipping an un-dismiss path (more surface than the problem warrants).

### A single resolver is a deliverable of this plan, not an aspiration

`.ai/plans/chrono/active/onboarding-wizard/README.md` stakes its entire no-drift guarantee
on both routes deriving from one computation. That only holds if **this** plan builds it,
so it is specified here as a named file rather than left to the implementor's judgement:

`apps/chrono-api/src/modules/onboarding/service.ts` exports
`resolveOnboardingState(tenantId, userId, permissions): Promise<OnboardingChecklistState>`.
Every route in both plans is a thin caller. Do **not** inline the queries in the handler
(the `shift/routes.ts` pattern this plan otherwise copies *does* inline, so this is a
deliberate departure from that precedent — the wizard is why).

**Short-circuit:** `resolveOnboardingState` reads the dismissal row **first** and returns
early when dismissed, before running any of the seven probes. Without this, every dashboard
load runs seven probes forever, including for tenants that dismissed the card long ago.

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

- Any checklist item beyond the seven named (no "connect billing", no "verify domain",
  no loyalty/promo/voucher setup — those are optional revenue features, not
  prerequisites to trading).
- Per-role customization of *which* items are listed — every role sees all seven; only
  the `actionable` flag (link vs. "Ask an admin") varies. Hiding items per role would
  make `completedCount`/`total` mean different things to different people on the same
  tenant.
- The active/inline setup flow — that is its own plan
  (`.ai/plans/chrono/active/onboarding-wizard/README.md`), which consumes this plan's
  item registry rather than defining its own.
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

**Files to update** (all paths verified to exist)
- `packages/agora/src/db/schema/tenant.ts` — add `tenantOnboardingDismissal` beside
  `tenantBranding` (line 65) / `tenantSecurityPolicy` (line 489)
- `packages/agora/src/db/schema/index.ts` — no edit needed: it already does
  `export * from "./tenant"` (line 2), so the new table is exported automatically
- `apps/agora-api/src/db/schema.ts` — re-export from `base` + add
  `"TenantOnboardingDismissals"` to `APP_TENANT_TABLES`
- `apps/chrono-api/src/db/schema.ts` — same two edits (the `export const { … } = base`
  destructure at line ~73, and `APP_TENANT_TABLES` at line 211)

**Step-by-step tasks**
1. Define `tenantOnboardingDismissal` table exactly as specified in Pass 2's schema
   block, in the foundation schema file.
2. Export it from the foundation schema barrel.
3. Add its table name to `APP_TENANT_TABLES` in both `apps/agora-api` and
   `apps/chrono-api` (it is a foundation table, so both apps that compose
   `agora/db/schema` must register it for RLS).
4. Generate + migrate **per app** — each app has its own `drizzle.config.ts`
   (`schema: "./src/db/schema.ts"`, `out: "./drizzle"`) and its own `db:generate` /
   `db:migrate` scripts, so the migration histories are separate regardless of whether
   the two apps happen to point at the same Neon project:
   `pnpm --filter @agora/chrono-api db:generate --name add_tenant_onboarding_dismissals`
   then `pnpm --filter @agora/chrono-api db:migrate` (which also re-runs
   `src/db/rls.run.ts`), and the same pair for `@agora/api`.
5. Run `pnpm --filter @agora/chrono-api rls:proof` (script exists:
   `tsx src/rls-proof.ts`) and `pnpm --filter @agora/api rls:proof` — both must print
   `RLS PROOF: PASS ✅`.

**Acceptance criteria**
- `TenantOnboardingDismissals` exists, RLS-forced, one row max per `tenantId`
  (unique index enforced at the DB level).
- `rls:proof` prints `RLS PROOF: PASS ✅` for every app that composes this table.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof` **and** `pnpm --filter @agora/chrono-api rls:proof`
  (Chrono does have its own: `apps/chrono-api/package.json` → `"rls:proof": "tsx src/rls-proof.ts"`).
  Both are unconditional — an earlier draft hedged with "if it has its own", contradicting
  steps 4–5 above.

**Out of scope:** any Chrono-specific table — this phase touches only the foundation.

**Execution start point:** read `tenantBranding` (`packages/agora/src/db/schema/tenant.ts:65`)
first and match its exact column/`uniqueIndex` style before adding the new table beside it.

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
- `pnpm --filter @agora/chrono-api test:onboarding-registry` — a new per-file `tsx` entry
  added to `apps/chrono-api/package.json`, matching the 17 existing `test:*` scripts there.
  Do **not** write `pnpm --filter @agora/agora test`: the package is named `agora`, and it
  has no test script (only `typecheck`/`clean`).

**Out of scope:** any Chrono item definitions — foundation-only.

**Execution start point:** copy `packages/agora/src/contracts/module-registry.ts`
line-for-line as the starting structure, then adapt field names.

---

## Phase 3 — Chrono item definitions, routes, service

**Files to update**
- `apps/chrono-api/src/modules/onboarding/contracts.ts` (new)
- **`apps/chrono-api/src/modules/onboarding/service.ts` (new) — `resolveOnboardingState()`.
  Not optional.** The `onboarding-wizard` plan's entire no-drift guarantee rests on both
  routes calling this one function. If it is inlined into the handler instead, that plan
  silently degrades into a refactor-in-a-later-plan.
- `apps/chrono-api/src/modules/onboarding/routes.ts` (new — thin callers only)
- `apps/chrono-api/src/routes/rpc.ts` (compose `onboardingRoutes()`)

**Step-by-step tasks**
1. Define `CHRONO_ONBOARDING_ITEMS` — all seven, in the stage order of the item-set
   table above. Six resolve as tenant-scoped existence probes inside one
   `withTenant(tenantId, tx => …)` (`chronoBranch`, `chronoStationGroup`,
   `chronoStation`, `chronoProduct`, **`chronoDeviceProvisioningToken`** — not
   `chronoDevice`, see the item-set table — and `chronoShift`). The seventh
   (staff-invited) probes `member` count > 1 **OR** a pending `invitation` row, both via
   `adminDb` filtered explicitly by `organizationId` — both are foundation org tables,
   **not** RLS-scoped, so this one resolver deliberately does **not** go through
   `withTenant`, exactly as `.ai/rules/tenant.md` requires.
   Each item carries its `requiredPermission` (per the item-set table) so the route can
   compute `actionable` without the item definitions knowing about the request.
   Use `EXISTS`/`limit(1)`, not `count(*)`, for the six existence probes — nothing needs
   the cardinality, and a seven-probe dashboard read should stay cheap.
2. Implement `resolveOnboardingState(tenantId, userId, permissions)` in `service.ts`. It
   reads the dismissal row **first** and returns early when dismissed, before running any
   probe.
3. Implement `GET /onboarding/checklist` and `POST /onboarding/checklist/dismiss` as thin
   callers — no `requirePermission` on either, per the Permission vocabulary section;
   both resolve `tenantId`/`userId` from `c.var.tenant`, never client input. Dismissal
   upserts on `(tenantId, userId)`.
4. Compose `onboardingRoutes()` into `apps/chrono-api/src/routes/rpc.ts`.

**Acceptance criteria**
- `GET /onboarding/checklist` returns correct `done` flags against real tenant state in
  manual testing (create a branch → item flips to done on next fetch).
- `POST /onboarding/checklist/dismiss` persists and the next `GET` reflects
  `dismissed: true`.
- Cross-tenant isolation: tenant A's checklist never reflects tenant B's branches/
  stations/members.
- A dismissed checklist runs **zero** probes (assert by log or query count) — the
  short-circuit is a performance requirement, not a nicety.
- One user dismissing does not hide another user's card on the same tenant.
- `grep -rn "resolveOnboardingState" apps/chrono-api/src` shows one definition; the
  handlers contain no probe queries of their own.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** UI (Phase 4), e2e spec (Phase 5).

**Execution start point:** copy `apps/chrono-api/src/modules/shift/routes.ts`'s file
*structure* (imports, factory shape, `withTenant` usage) as the skeleton, then strip out
everything permission-gated. **Deliberately depart from it in one respect:** that module
inlines its queries in the handler; this one must not — the probes live in `service.ts`
(see Files to Update).

---

## Phase 4 — Web UI

**Files to update** (paths verified)
- `apps/chrono-web/src/components/dashboard/onboarding/onboarding-checklist-card.tsx`
  (new)
- `apps/chrono-web/src/app/dashboard/page.tsx` — **confirmed to exist** (93 lines,
  `OverviewPage`). Note it is currently still the *unmodified agora scaffold* overview
  (Projects / Members / "RLS active" cards), not a Chrono-specific dashboard. It is a
  `"use client"` component that already fetches `/rpc/me`, `/rpc/projects`,
  `/rpc/members` and `/rpc/billing` in one `useEffect`. Add the checklist fetch to that
  same effect rather than introducing a second one.
- `apps/chrono-web/src/lib/rpc.ts` — the typed `api` client already exists and is
  imported by that page; no new client needed.

**Step-by-step tasks**
1. Build `OnboardingChecklistCard` from `agora/ui` primitives only (`Card`, `Badge`,
   `Button`) per `.ai/rules/component-first-ui.md` — no raw HTML chrome.
2. Fetch `GET /onboarding/checklist` on the dashboard page; render nothing if
   `dismissed`.
3. Wire the dismiss button to `POST /onboarding/checklist/dismiss` with optimistic
   collapse and a `toast.error(...)` on failure (`sonner`, per the UI rules table).

**Acceptance criteria**
- Card renders for a fresh tenant with 0/7 done, updates live as items complete, and
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
1. Happy path: sign up a fresh tenant, assert the card shows 0/7, create a branch via
   the real branches flow, reload, assert 1/3.
2. Role gate: no permission is introduced, so the gate under test is the **`actionable`
   flag**, not access. Assert that a `staff` user sees all seven items with the same
   `completedCount`/`total` as an `owner`, but with `actionable: false` on exactly the
   four they lack (`branch`, staff-invite, `pos:manageProducts`, `device:manage`) —
   rendered as "Ask an admin", not as links. This test must fail if `CHRONO_STAFF_GRANTS`
   is widened without updating the item table, which is the drift this asserts against.
   Also assert a `staff` user can still dismiss (dismissal is deliberately ungated).
3. Cross-tenant isolation: create two tenants, complete an item in tenant A only, assert
   tenant B's checklist is unaffected.

**Acceptance criteria**
- All three scenarios pass under the Playwright run per
  `.ai/rules/rbac.md`'s testing note, if this suite requires `pnpm dev` running).

**Verification commands**
- `pnpm --filter @agora/chrono-web e2e -- onboarding` (the script is `e2e`, NOT `test:e2e`
  script name)

**Out of scope:** load/perf testing of the checklist read (it is a handful of cheap
existence queries, not a candidate for a dedicated perf test).

**Execution start point:** copy the nearest existing dashboard-flow spec's setup
(faker-based tenant creation) as the fixture.

---

## Resolved open questions (verified against the repo, 2026-09-02)

All five original open questions are answered from the code. Nothing here still blocks
implementation.

1. **Foundation schema layout** — split, with a barrel:
   `packages/agora/src/db/schema/` holds `auth.ts`, `customer.ts`, `platform.ts`,
   `tenant.ts`, `index.ts`. Add `tenantOnboardingDismissal` to **`tenant.ts`**; `index.ts`
   already re-exports it via `export * from "./tenant"`, so no barrel edit.
2. **One migration or two** — **two**, one per app. Each app owns its own
   `drizzle.config.ts` (`out: "./drizzle"`) and its own `db:generate`/`db:migrate`
   scripts, so migration histories are independent even if both point at the same Neon
   project. See the revised Phase 1 step 4.
3. **`BASE_TENANT_TABLES`** — **does not exist.** The identifier appears only inside
   doc comments in `packages/agora/src/db/schema/platform.ts`. Every app hand-lists
   every foundation table it wants RLS-forced in its own `APP_TENANT_TABLES`
   (`apps/chrono-api/src/db/schema.ts:211` lists 12 foundation tables + 29 Chrono ones).
   So Phase 1 edits both apps' arrays.
4. **`staff-invited` resolver** — no existing "does this tenant have >1 member" helper
   exists in `apps/chrono-api/src`. But there **is** a better reuse than a fresh
   `adminDb` count: `GET /rpc/members` already returns paginated `meta.totalItems`, and
   `apps/chrono-web/src/app/dashboard/page.tsx` already calls it with `pageSize: "1"`
   purely to read that number. Two options, decide at implementation time:
   - **(a) server-side resolver** (as originally planned): a `count()` on `member`
     filtered by `organizationId` via `adminDb` — `member` is a foundation org table and
     is **not** RLS-scoped, so it must not go through `withTenant`
     (`.ai/rules/tenant.md`). Keeps all three items in one `GET /onboarding/checklist`
     response — **recommended**, since a checklist whose items resolve in two different
     places is the kind of split that rots.
   - **(b) client-side**: reuse the `meta.totalItems` the dashboard already fetches.
     Cheaper by one query but leaks item-definition logic into the web app, contradicting
     the "items are code-defined per app, in the API" decision in Pass 2. Rejected unless
     the extra query proves to be a measured problem.
5. **Chrono dashboard root** — **confirmed**: `apps/chrono-web/src/app/dashboard/page.tsx`
   exists (93 lines). Caveat recorded in Phase 4: it is still the untouched agora
   scaffold overview page, not yet a Chrono-specific dashboard.

### New finding — not in the original plan

`apps/chrono-api/src/modules/` currently holds 19 modules (`branch`, `station`, `member`,
`shift`, `session`, `pos`, `wallet`, `credit`, …) and **no `onboarding` module** — so
Phase 3 is genuinely greenfield, and the plan's stated dependencies (`branches`,
`stations`, `member`) are all present as real modules. `apps/chrono-web/src/app/dashboard/`
has no `onboarding/` route either. Nothing to reconcile or migrate; every phase starts
from zero.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/onboarding-checklist/` to
`.ai/plans/chrono/archive/onboarding-checklist/` once all 5 phases are verified and
committed, and update `.ai/handover/chrono-migration.md`'s deferred-modules list to drop
`onboarding-checklist` and its plan-status table to mark it done.

## Status: COMPLETE (2026-09-02)

All five phases landed and verified.

- **Phase 1** (foundation schema) — `e610517`. `TenantOnboardingDismissals`
  live on both apps, RLS enabled+forced.
- **Phase 2** (foundation contracts + registry seam) — `16f6aaf`. 24/24 unit tests.
- **Phase 3** (Chrono item definitions, service, routes) — `67a1660`. 15/15 acceptance
  tests against real Postgres; `grep -rn "resolveOnboardingState"` confirms exactly one
  implementation.
- **Phase 4** (web UI) — `fb4fa8a`. `OnboardingChecklistCard`, stage-grouped, optimistic
  dismiss with toast+rollback on failure.
- **Phase 5** (e2e spec) — `446159a`. Happy path, the `actionable`-flag drift test
  (fails if `CHRONO_STAFF_GRANTS` widens without updating this test), tenant isolation.

Unblocks `onboarding-wizard`, whose Phase 1 has already landed (`021ff25`).
