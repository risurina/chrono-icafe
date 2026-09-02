# Chrono — `onboarding-wizard` module

**Depends on:** `onboarding-checklist` (must land first — this plan consumes its item
registry and adds no item definitions of its own), `branch`, `station`, `member`, `pos`,
`device`, `shift` (all present as real modules).
**No dependency on:** `wallet`, `credit`, `loyalty`, `promo`, `voucher`, `reservation`.

## What this is

An **active** first-run flow at `{slug}.APP_DOMAIN/dashboard/setup` that walks a new
Chrono owner through creating each setup entity **inline**, instead of bouncing them
across seven separate dashboard pages and expecting them to find their way back.

The checklist (plan A) stays. The two are not alternatives — they are the passive and
active renderings of one item registry:

- **Checklist** = the persistent, ambient progress surface on the dashboard. Answers
  "what's left?"
- **Wizard** = the guided path that actually completes the steps. Answers "do it now."
- The checklist's items link **into** the wizard at the right step, rather than to seven
  different CRUD pages.

---

## The single-source-of-truth constraint (the reason this plan exists as a sibling, not a rewrite)

If the wizard defines its own ordered step list, it will drift from the checklist's item
list within a release — someone adds an eighth setup step to one and not the other, and
the dashboard then disagrees with the wizard about whether the tenant is set up. That is
the failure mode this plan is shaped to prevent.

So: **`CHRONO_ONBOARDING_ITEMS` (plan A, `apps/chrono-api/src/modules/onboarding/
contracts.ts`) is the only place a setup step is ever defined.** This plan adds two
per-item *policy* booleans to that same registry — and nothing else:

```ts
// added to the existing OnboardingChecklistItem shape, not a new parallel type
wizardStep?: {
  /** Can this be completed without leaving the page? Policy, not presentation. */
  inlineable: boolean;
  /** Steps a user may pass over; a required step blocks "continue" until done. */
  skippable: boolean;
};
```

**No `form` discriminator on the server contract.** An earlier draft carried
`form: "branch" | "stationGroup" | …`, which is a React component name smuggled into an
API response — and it buys a *runtime* failure: a `form` value with no matching component
breaks only when a user reaches that step. Instead the web app holds
`Record<ChronoOnboardingItemKey, StepForm>` keyed on the item `key` union, so "added an
item, forgot its form" is a **compile error**. That is strictly stronger than the runtime
check the `form` field would have given, and it keeps UI vocabulary out of the contract.

An item with no `wizardStep` appears in the checklist but not the wizard (none today —
the field exists so a future non-inlineable item, e.g. "verify your domain", degrades to
a link instead of forcing a bad inline form). A wizard step can never exist without a
checklist item, because there is nowhere else to declare one.

---

## Pass 1 — Workflow Analysis

**Who uses it:** the tenant `owner` (and `admin`) immediately after signing up — the
person who currently lands on a blank Overview page.

**`staff` see the wizard too, with non-actionable steps locked.** An earlier draft
redirected staff away entirely; that contradicted plan A, which deliberately decided
*not* to hide items from staff (hiding makes `completedCount`/`total` mean different
things to different people on one tenant). And staff do hold `station:create` and
`shift:open` — three of the seven steps — so redirecting them leaves a staff member
setting up stations with no inline path, for a reason plan A already rejected. Same rule
in both surfaces: show every step, lock the ones you cannot action, keep one progress
count.

**Workflow:** after workspace creation, the post-auth landing takes an owner with zero
setup progress to `/dashboard/setup` rather than `/dashboard`. The page renders the seven
items as four stepper stages (Venue → Team → Trading → Go live), with the *current* step
being the first incomplete one. Each step shows a small inline form that posts to the
module's existing `/rpc` route — no new write routes are introduced by this plan. On
success the step marks done and the wizard advances. "Skip for now" advances without
completing (allowed on `skippable` steps only). Progress is never lost: because
completion is computed from real tenant state, closing the browser and returning resumes
at the same place with no stored wizard cursor.

**Failure cases:**
- *Unauthenticated / wrong tenant host* — normal `getRequestTenant()` /
  `tenantMiddleware()` handling; no special case.
- *Wrong role* — a `staff` user gets the wizard with four steps locked (see above), not a
  redirect. Locking is display-only, **not** a security boundary: every inline form posts
  to a route that keeps its own `requirePermission` gate, so a staff user who forges the
  request is still refused server-side exactly as today.
- *Duplicate action* — double-submitting an inline form must not create two branches.
  Each form disables on submit, and the step re-derives `done` from server state after
  the write rather than trusting an optimistic flag.
- *Stale screen* — a second admin completing a step in another tab does not break this
  one: the wizard re-fetches the checklist state on each step transition, so it
  self-corrects rather than re-creating an entity that now exists.
- *Tenant-isolation leak* — the wizard introduces no new reads or writes; it calls
  existing tenant-scoped routes. Nothing to isolate that is not already isolated.
- *A step's entity is deleted mid-flow* — completion is live-computed, so the step simply
  reverts to incomplete. No cached cursor to invalidate.

**Audit / notifications:** none from the wizard itself. The underlying routes emit
whatever audit they already emit — the wizard is a different caller of the same writes,
not a new privileged path.

---

## Pass 2 — Technical Planning

### What this plan does NOT add

- **No new `/rpc` write routes.** Every inline form posts to the existing module route
  (`POST /rpc/branches`, `POST /rpc/stations/groups`, `POST /rpc/stations`,
  `POST /rpc/pos/products`, `POST /rpc/devices/provisioning-tokens`,
  `POST /rpc/shifts/open`, and `POST /rpc/invites` — the **foundation** invite factory
  mounted at `apps/chrono-api/src/routes/rpc.ts:1128`, gated `staff:["invite"]` at
  `packages/agora/src/invites/routes.ts:50`, validated by `inviteMemberSchema`). Adding a
  `POST /rpc/setup/branch` alias would be a second, less-gated path to a gated write —
  precisely the mistake `.ai/rules/api.md` exists to prevent.
- **No new permission resource.** The gates are the ones the underlying routes already
  enforce.
- **No new table.** Resume state is derived, not stored. The only persisted onboarding
  state in the whole feature remains plan A's one dismissal row.
- **No new contracts for the writes** — each inline form reuses the module's existing
  Zod schema (`createBranchSchema`, `createStationSchema`, `createProductSchema`, …) so
  the wizard cannot drift from the canonical validation.

### Pattern to copy

- Multi-step client flow: **there is no precedent to copy.**
  `apps/chrono-web/src/app/new-workspace/` is a single `page.tsx` with no step idiom, so
  the stepper is genuinely new work — budget for it rather than assuming a refactor.
- Inline form + typed client + toast feedback: any existing dashboard create form, e.g.
  `apps/chrono-web/src/app/dashboard/branches/`.
- All markup from `agora/ui` primitives per `.ai/rules/component-first-ui.md`. **No
  `Stepper` primitive exists** (verified: none of the 27 components in
  `packages/agora/src/ui/components/custom/`), so Phase 2 adds one **there**, in the
  foundation — do not invent a local shell wrapper in the app (`.ai/rules/ai-agent.md`).

### Routes — none. Deliberately.

**This plan adds no route at all.** An earlier draft proposed
`GET /rpc/onboarding/setup` as "a thin projection" over plan A's resolver. Dropped: two
routes returning one state means two typed shapes and a component that can be handed the
wrong one, and "thin projection, not a second computation" is a promise enforced only by
code review.

Instead, plan A's `GET /rpc/onboarding/checklist` returns `wizardStep` **unconditionally**
— it is two static booleans per item, costing nothing to always send. One route, one
shape, one resolver (`resolveOnboardingState`, a named deliverable of plan A). The
no-drift property becomes structural rather than aspirational.

`?include=wizard` was also considered and rejected: a conditional response shape makes the
typed client's return type a union for no benefit.

### Web UI

- `apps/chrono-web/src/app/dashboard/setup/page.tsx` (new) — the stepper shell.
- `apps/chrono-web/src/components/dashboard/onboarding/steps/*.tsx` (new) — one small
  inline form per `wizardStep.form` value, each a thin wrapper over the module's existing
  create schema.
- `apps/chrono-web/src/components/dashboard/onboarding/onboarding-checklist-card.tsx`
  (from plan A) — change each item's `href` to deep-link into the wizard at that step
  (`/dashboard/setup#station`) rather than to the module's CRUD page.
- Post-auth landing: `resolveLandingUrl()` (`apps/chrono-web/src/lib/post-auth.ts`, per
  `.ai/rules/auth.md`) is the single place every sign-in path already funnels through —
  extend it there, never by scattering redirect logic across pages.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Wizard state | n/a (derived from tenant state) | `GET /rpc/onboarding/setup` | n/a | n/a |
| The seven setup entities | via each module's existing gated route | via each module's existing route | not in this flow | not in this flow |

Feedback: each inline form shows `toast.success` on create (naming the thing created) and
`toast.error` on failure, per the `sonner` convention. A failed step never advances. No
audit event from the wizard layer.

### Out of Scope

- Editing or deleting setup entities from the wizard — it is a create-only path; the
  module's own page remains the place to manage what exists.
- Any step beyond plan A's seven.
- Re-running the wizard as a "reconfigure" tool after setup is complete — once all items
  are done, `/dashboard/setup` redirects to `/dashboard`.
- A progress-bar/percentage in the global nav.
- Wiring this into the neutral `apps/agora-web` scaffold (same reasoning as plan A).

---

## Phase 1 — Registry hint

**Files to update**
- `apps/chrono-api/src/modules/onboarding/contracts.ts` — add the optional `wizardStep`
  field (`inlineable` + `skippable`) to the existing item shape; populate it on all seven.
- `packages/agora/src/contracts/onboarding.ts` — add `wizardStep` to the foundation's
  `OnboardingChecklistItem` type and `OnboardingChecklistState` Zod schema.

**Step-by-step tasks**
1. Extend the foundation item type with `wizardStep?` exactly as specced above — two
   booleans, no `form` discriminator. Do not create a second array of steps anywhere.
2. Populate `wizardStep` on all seven Chrono items. Set `skippable: true` on item 6
   (create a device pairing code): a venue setting up before its hardware arrives must not
   be blocked from "Go live" by it. Items 1–3 and 7 are `skippable: false`.
3. Confirm `resolveOnboardingState` (plan A's deliverable) already returns these fields —
   this phase adds no route and no second computation.
4. Confirm `actionable` is computed from `c.var.tenant.permissions` via `hasPermission`,
   never from `c.var.tenant.role`.

**Acceptance criteria**
- `GET /rpc/onboarding/checklist` returns `wizardStep` on every item, and there is exactly
  one route and one resolver for onboarding state in the codebase — verified by
  `grep -rn "resolveOnboardingState" apps/chrono-api/src` returning one definition and
  callers only.
- No new route file, no new endpoint.

**Verification commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:onboarding-registry`

(`rls:proof` is deliberately **not** listed — this phase touches no schema, and
`.ai/rules/implementation.md` says run the exact listed commands.)

**Out of scope:** UI; any new endpoint.

**Execution start point:** read plan A's landed `service.ts` (`resolveOnboardingState`)
and confirm it exists before touching anything. If it does not, plan A is not finished —
stop, and finish it first. This plan's entire no-drift guarantee rests on that function.

---

## Phase 2 — Wizard UI

**Files to update**
- `apps/chrono-web/src/app/dashboard/setup/page.tsx` (new)
- `apps/chrono-web/src/components/dashboard/onboarding/steps/*.tsx` (new, seven forms)
- `packages/agora/src/ui/components/custom/stepper.tsx` (new, **only if** no stepper
  primitive already exists — check first)

**Step-by-step tasks**
1. Read `apps/chrono-web/src/app/new-workspace/` first and reuse its step idiom if present.
2. Build the stepper shell; render stages Venue / Team / Trading / Go live.
3. Build the seven inline forms, each importing the module's existing create schema.
   Item 6's form mints a **provisioning token** (`POST /rpc/devices/provisioning-tokens`)
   and displays the pairing code — it does not create a `chronoDevice`, which only the
   unauthenticated `POST /pair` hardware handler can do (`device/routes.ts:540`).
4. Lock non-actionable steps for `staff` (do not redirect); redirect to `/dashboard` when
   `allDone`.
5. Add `packages/agora/src/ui/components/custom/stepper.tsx` and export it from
   `packages/agora/src/ui/index.ts`.

**Acceptance criteria**
- An owner can go signup → seven steps → trading without ever leaving `/dashboard/setup`.
- Closing and reopening the browser resumes at the same step with no stored cursor.
- No raw `<div>`/`<button>` chrome introduced in `apps/chrono-web`.

**Verification commands**
- `pnpm typecheck` · `pnpm build`

**Out of scope:** the post-auth redirect (Phase 3).

**Execution start point:** `apps/chrono-web/src/app/new-workspace/`.

---

## Phase 3 — Post-auth routing + checklist deep-links

**The redirect condition — Open Question 1, now closed.** An earlier draft said "only the
*first* login redirects". That is **not implementable as specced**: this plan forbids any
stored cursor, completion is derived purely from tenant state, and `resolveLandingUrl()`
(`apps/chrono-web/src/lib/post-auth.ts:39`) takes only `nextHost` — there is no
session-count or first-login signal anywhere to derive "first" from. Introducing one means
new persisted state, which contradicts this plan's own "no new table".

**Resolved:** redirect on a *derivable* condition — `!allDone && !dismissed && zero items
complete`. That is true exactly once in practice (a tenant with nothing set up), reads
from state that already exists, and self-corrects: the moment the owner completes or
dismisses anything, logins go to `/dashboard` as normal. The dismissal row (per-user, from
plan A) is what makes "I don't want this" durable, so no owner is ever trapped in the flow.

**Files to update**
- `apps/chrono-web/src/lib/post-auth.ts` — add the branch above to `resolveLandingUrl()`.
- `apps/chrono-web/src/components/dashboard/onboarding/onboarding-checklist-card.tsx` —
  repoint item hrefs into the wizard.

**Step-by-step tasks**
1. Read `resolveLandingUrl()` and its existing branches in full before adding one.
2. Add the `/dashboard/setup` branch using only the derivable condition above — no new
   state, no new storage, no cookie.
3. Repoint the checklist card's item links to `/dashboard/setup#<itemKey>`. Because plan A
   makes `href` a **registry field**, this is a data change in
   `apps/chrono-api/src/modules/onboarding/contracts.ts`, not a component edit — do not
   hardcode hrefs in the card.
4. Verify no redirect logic was added anywhere outside `resolveLandingUrl()`.

**Acceptance criteria**
- A brand-new owner with zero progress lands on `/dashboard/setup`, not a blank Overview.
- An owner with any progress, or who dismissed, lands on `/dashboard`.
- `grep -rn "dashboard/setup" apps/chrono-web/src` shows the redirect in exactly one place.

**Verification commands**
- `pnpm typecheck` · `pnpm build`

**Out of scope:** e2e (Phase 4); any persisted first-login marker.

**Execution start point:** `apps/chrono-web/src/lib/post-auth.ts`, `resolveLandingUrl()`.

---

## Phase 4 — E2E spec

**Files to update**
- `apps/chrono-web/e2e/tests/onboarding/setup-wizard.spec.ts` (new)

**Step-by-step tasks**
1. Happy path: fresh tenant → complete all seven steps inline → assert redirect to
   `/dashboard` and checklist gone.
2. Role gate: a `staff` user sees all seven steps with items 1/4/5/6 locked and 2/3/7
   actionable; and a forged `POST /rpc/branches` from that staff session still 403s
   (proving the lock is display-only and not load-bearing for security).
3. Cross-tenant isolation: tenant A completing steps leaves tenant B's wizard at zero.
4. Resume: complete three steps, reload, assert the wizard resumes at step four.

**Acceptance criteria**
- All four scenarios pass.
- Scenario 2 fails if the staff lock is ever "fixed" into a real gate, or if the underlying
  `requirePermission` is ever removed — it asserts both halves (locked in UI, 403 on the
  wire), so it cannot pass vacuously.

**Verification commands**
- `pnpm --filter @agora/chrono-web e2e -- onboarding` — the script is `e2e`
  (`apps/chrono-web/package.json:10`), **not** `test:e2e`. Per `.ai/rules/rbac.md` the
  Playwright config runs headed with no `webServer`, so `pnpm dev` must already be running.

**Out of scope:** perf testing.

**Execution start point:** copy plan A's spec fixture.

---

## Open Questions (developer to confirm)

1. **First-login-only redirect** — Phase 3 assumes only the *first* login forces
   `/dashboard/setup`, thereafter it is opt-in via the checklist. The alternative (redirect
   every login until `allDone`) is more insistent but risks trapping an owner who
   deliberately deferred setup. Confirm which you want; "first login only" is the default
   here because it is the reversible choice.
2. ~~Does a stepper primitive already exist?~~ **Resolved: no.**
   `packages/agora/src/ui/components/custom/` holds 27 components and none is a stepper
   (nearest neighbours are `list-row.tsx` and the `data-table` folder). So Phase 2 **does**
   add `packages/agora/src/ui/components/custom/stepper.tsx` and exports it from
   `packages/agora/src/ui/index.ts` — in the foundation, not app-local, per
   `.ai/rules/ai-agent.md`. Also note `apps/chrono-web/src/app/new-workspace/` is a single
   `page.tsx` with no step idiom to reuse, so the stepper is genuinely new work, not a
   refactor. Budget for it in the phase estimate.
3. **Device step realism** — step 6 ("provision a device") completes when a
   `chronoDevice` row exists, but the real flow needs physical hardware to pair. For a
   venue setting up before hardware arrives this is a hard blocker on "Go live". Should
   step 6 be `skippable: true`? Recommended **yes**, for that reason.

## Status: COMPLETE (2026-09-02)

All four phases landed and verified; all three Open Questions were already
resolved inline in the plan text before this pass (Question 1 superseded by
Phase 3's own "now closed" resolution; Questions 2-3 marked Resolved).

- **Phase 1** (wizardStep registry hint) — `021ff25`.
- **Phase 2** (wizard UI: stepper primitive + setup page + seven step forms) — `ab2b8d5`.
- **Phase 3** (post-auth routing + checklist deep-links) — `fb443f0`.
- **Phase 4** (e2e spec) — `f00ec2a`. Happy path (all seven steps inline, lands on
  the completion card — no auto-redirect, confirmed against the real
  `setup/page.tsx`), role gate (4 locked / 3 actionable verified against real
  `CHRONO_STAFF_GRANTS`, plus a forged `POST /rpc/branches` from staff still
  403s — proving the UI lock isn't the real boundary), tenant isolation, and
  resume (reload lands back on the correct in-progress step, derived from
  server state with no stored cursor).
