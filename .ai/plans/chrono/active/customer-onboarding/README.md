# Chrono — `customer-onboarding`

**Surface:** `/portal` (the tenant-scoped end-customer area), **not** `/dashboard`.
**Depends on:** **`member-approval-guard` (must land first — see Decision 4)**;
`member` (done — `portal-routes.ts` exists), `wallet` (done, has `portal-routes.ts`),
`credit`, `session` (both have portal routes), foundation `agora/member-auth` +
`agora/customer-auth`.
**Distinct from:** `onboarding-checklist` / `onboarding-wizard`, which are the *tenant
owner's* venue setup. Nothing is shared between them but the word "onboarding" — different
actor, different surface, different auth pool. They must not be merged.

## What this is

The journey from "a walk-in signs up on the venue's portal" to "they can actually play":
today that journey **dead-ends**. This plan makes it a guided, legible path.

---

## Pass 1 — Workflow Analysis

**Who uses it:** a `tenantMember` — the venue's end customer, authenticating through
`agora/member-auth` (cookie `agora_member`) or as a global `customer` who applied to this
tenant (`agora/customer-auth`, cookie `agora_customer`). **Never** a Better Auth staff
`user`. Per `.ai/rules/business-app.md` this pool is reused as-is; Chrono extends it only
through `ChronoMemberProfiles` (`apps/chrono-api/src/modules/member/schema.ts`).

### The gap, as the code stands today

Verified in `apps/chrono-api/src/modules/member/portal-routes.ts:56` and
`schema.ts:21`: self-service portal signup writes
`applicationStatus: "pending"`, and `chronoMemberProfile.applicationStatus` defaults to
`"pending"`. Staff then approve or reject via `POST /rpc/member-profiles/:memberId/approve` /
`/reject` (gated `customer:approve` / `customer:reject`,
`apps/chrono-api/src/modules/member/routes.ts:162,188`). Note the mount prefix is
**`/member-profiles`** (`apps/chrono-api/src/routes/rpc.ts:1142`), not `/members` — an
earlier draft of this plan had it wrong throughout, which would have put every new route
in the wrong router. Meanwhile
`apps/chrono-api/src/modules/session/routes.ts:161-165` will only start a session for a
profile whose `applicationStatus === "approved"`.

So a customer who signs up:

1. lands on `/portal` (`apps/chrono-web/src/app/portal/page.tsx`), which the code itself
   labels *"Placeholder — extend with your customer-facing features"*;
2. sees a wallet balance component and an application state, with **no explanation of
   what pending means, how long it takes, or what to do next**;
3. gets **no notification when they are approved** — they must guess and come back.

   *(An earlier draft of this plan claimed a pending customer "cannot start a session".
   That was wrong. `applicationStatus` has no access enforcement anywhere —
   `session/routes.ts:161-165` is its only consumer outside the approve/reject handlers,
   and it selects `memberRate` vs `hourlyRate`, a **pricing** decision;
   `member/schema.ts:20` says so explicitly: "this field carries no enforcement yet". A
   pending customer can play, at standard rate. The gap is that nothing tells them a
   member rate exists or that they are waiting on it — which is a real UX gap, just not
   a lockout.)*

That is the onboarding to fix. The venue side of the same gap: staff have no prompt that
someone is waiting, so approvals stall.

**Failure cases:** rejected applicant (must be told, and told whether they can re-apply);
approved-but-never-returns (needs the notification in step 4); a global `customer` who
applied via `POST /portal/customer/apply` and gets **instant** access per
`.ai/rules/business-app.md` — so the pending state must not be assumed universal; wallet
with zero balance (needs a top-up prompt, not an empty state); tenant isolation — a
member of tenant A must never see tenant B's portal state.

**Audit / notifications:** approval/rejection are already-gated mutations; this plan adds
the customer-facing *notification* on that transition, and a staff-facing pending count.

---

## Pass 2 — Technical Planning

### Decision 1 — resolve `pending` vs `approved` (the handover's open question)

`.ai/handover/chrono-migration.md` records this as unresolved: *"`members`: self-service
sign-up defaults to `applicationStatus: 'pending'` (oikos behavior) vs `'approved'`
(agora's existing instant-access precedent)."* The handover's own standing instruction is
to resolve such questions *"toward the better design by default, not toward parity with
oikos."*

**Recommendation: keep `pending`, but make the wait legible** — do not flip to instant
approval. Reasons:

- A venue that takes payment and hands over a physical station has a real reason to vet a
  walk-in; instant access removes a control the business wants, which a UX plan should
  not do unilaterally.
- The foundation's instant-access precedent applies to the *global customer apply* path,
  which is already instant and stays that way — so both behaviors coexist by design
  rather than by contradiction.
- The actual complaint is not "approval exists", it is "the wait is invisible". That is
  fixable without weakening the control.

**But make it configurable**, because the right answer is per-venue, not global: a
tenant-level setting `chrono.autoApproveMembers` (default `false`) exposed to the venue,
so a busy internet café can switch to instant access without a code change. Implement as a
**feature flag through the documented seam** — `buildFeatureFlagRegistry()` in
`apps/chrono-api/src/contracts/extensions.ts`, never by editing
`packages/agora/src/contracts/feature-flags.ts` (`.ai/rules/business-app.md`, "Extension
seams").

### Decision 2 — no new identity, no new table

Everything needed already exists: `tenantMember` (foundation), `chronoMemberProfile`
(Chrono's extension), `chronoWallet`, `chronoLoyaltyAccount`. This plan adds **no new
table**. Rebuilding customer identity here is the exact mistake `.ai/rules/business-app.md`
calls out as having cost a real rework once already.

### Decision 3 — eager wallet/loyalty provisioning is OPTIONAL POLISH, not a bug fix

Two claims in an earlier draft of this plan were false and are corrected here, because
they would have sent an implementor hunting a bug that does not exist:

- ~~"the current `/portal` page fetching a wallet that may not exist is a latent
  empty-state bug"~~ — **it is not.** `wallet/portal-routes.ts:47-51` deliberately returns
  `{ balance: "0.00", currency: "PHP", exists: false }`, with the comment *"No
  side-effecting auto-create on a read."* That is correct behaviour, not an oversight.
- ~~"a pending applicant should not accumulate financial records"~~ — **already
  guaranteed.** Both rows are created lazily on first *use*, idempotently, via
  `lockWalletForUpdate` (`wallet/service.ts:22-41`, `onConflictDoNothing` against unique
  index `chrono_wallet_member_uq`) and `ensureAccount`/`lockAccountForUpdate`
  (`loyalty/service.ts:40-62`, unique `chrono_loyalty_account_member_uq`).

So provisioning at approval is a **choice**, worth making only if you want a non-null
wallet visible from day one. If taken, Phase 1 must **reuse those two existing helpers**
(already `TenantTx`-shaped and already idempotent) rather than hand-rolling inserts —
"idempotent" naming no mechanism is exactly how a duplicate-wallet bug gets written.

### Routes

Extending the existing `/portal/members` and `/rpc/member-profiles` route files — no new
module:

| Route | Surface | Gate | Purpose |
|---|---|---|---|
| `GET /portal/members/me/onboarding` | portal | member session | The customer's own state: `applicationStatus`, what it means, next action, wallet provisioned?, first-session eligibility |
| `GET /rpc/member-profiles/pending-count` | dashboard | `customer:read` | Staff badge — how many are waiting |

The approve/reject routes keep their shape and their `customer:approve` /
`customer:reject` gates, but **must gain a status guard** — see Decision 4.

### Decision 4 — DEPENDENCY: the approve/reject guard is fixed elsewhere, first

Both the approve and reject handlers currently write their status transition with no
predicate on the current status, so a redundant call re-stamps the timestamp and writes a
false audit event. Once **this** plan adds a customer-facing email inside those handlers,
every duplicate call would also re-send the approval email.

That defect lives in **landed code** and is fixed by its own standalone plan —
`.ai/plans/chrono/active/member-approval-guard/README.md` — which is independently
shippable and does not wait for this one. It was originally written into this plan's
Phase 1; that was the wrong home, because this plan is unstarted and a live defect must
not be held behind an unbuilt feature.

**This plan therefore depends on `member-approval-guard` having landed**, and adds the
notification on top of its guard: emit only when the guarded update actually returned a
row, i.e. only on a genuine transition.

### Notifications

On approve/reject, send the customer an email via the foundation's `EmailSender`
(`agora/server` — `.ai/rules/providers.md`; never a direct vendor call), fired **only on a
real status transition** (Decision 4).

**Unresolved and blocking — do not delegate this part.** The recipient is a
`tenantMember`, who is **not** a Better Auth `user`. Whether the foundation's
`notificationTemplate` path (`packages/agora/src/db/schema/auth.ts:278`) can address a
`tenantMember` at all is **unverified**, and no template key is named yet. Confirm the
recipient-resolution path against the foundation before writing Phase 1; if it cannot
address a tenantMember, this becomes a foundation-level question, not a Chrono one.

### Web UI

- `apps/chrono-web/src/app/portal/page.tsx` — replace the placeholder home with a real
  state-aware home: **pending** (what happens next, expected wait, contact), **rejected**
  (no reason is shown — the column does not exist, see Out of Scope; state whether
  re-application is possible), **approved** (wallet balance,
  top-up prompt if zero, "start a session" call to action, loyalty balance).
- `apps/chrono-web/src/app/dashboard/members/` — surface the pending count as a badge so
  approvals stop stalling.
- All markup from `agora/ui` primitives.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| `chronoMemberProfile` | portal signup (`pending`, or `approved` when the flag is on) | portal: own only; dashboard: `customer:read` | approve/reject, gated | never (no delete path in MVP) |
| `chronoWallet` / `chronoLoyaltyAccount` | auto, in the approve transaction | own via portal routes | existing wallet/loyalty routes | n/a |

Feedback: portal actions toast on success/failure; the pending state is a persistent
informational panel, not a toast.

### Out of Scope

- Any change to `agora/member-auth` / `agora/customer-auth` themselves.
- Rejection *reasons* as a structured field. `chronoMemberProfile` has only `rejectedAt`
  (`member/schema.ts:24`) — no reason column. **Therefore the rejected state renders no
  reason** (see Web UI); an earlier draft promised "reason if recorded" while also
  deferring the column, which is a contradiction an implementor would have hit.
- SMS notification (email only; SMS is a platform integration question).
- Self-service re-application after rejection.
- The customer-facing booking/reservation journey — that is the `reservation` module's.

---

## Phase 1 — Feature flag + approval transaction

**Files to update**
- `apps/chrono-api/src/contracts/extensions.ts` — register `chrono.autoApproveMembers`
  via `buildFeatureFlagRegistry()` (create the file if this is Chrono's first own flag).
- `apps/chrono-api/src/modules/member/portal-routes.ts` — honour the flag at signup.
- `apps/chrono-api/src/modules/member/routes.ts` — provision wallet + loyalty inside the
  existing approve transaction; emit the notification.

**Step-by-step tasks**
1. Register `chrono.autoApproveMembers` (default `false`) in the **existing**
   `apps/chrono-api/src/contracts/extensions.ts` — the file exists, but both registries
   are currently empty (`buildFeatureFlagRegistry({})`, lines 19–20), so this is Chrono's
   **first ever** feature flag and the seam has never been exercised end-to-end.
2. **Define the app-local key type and wrapper**, or this will not compile:
   `getTenantFlag(tenantId, key: FeatureFlagKey, registry)`
   (`packages/agora/src/server/feature-flags.ts:241`) types `key` as the
   **foundation-only** literal union, so passing `"chrono.autoApproveMembers"` is a type
   error. Add `type ChronoFeatureFlagKey = keyof typeof CHRONO_FEATURE_FLAGS.flags` plus a
   thin app-local wrapper, exactly as `.ai/rules/business-app.md` prescribes for the
   permissions seam. Confirm `featureFlagRoutes(CHRONO_FEATURE_FLAGS)` is passing the
   merged registry (verified at `apps/chrono-api/src/routes/rpc.ts:460`).
3. Confirm `member-approval-guard` has landed (the approve/reject handlers carry their
   `ne(applicationStatus, …)` predicate). Do not add the notification before it —
   see Decision 4.
4. Honour the flag at portal signup (`portal-routes.ts:56`).
5. If taking the optional eager provisioning (Decision 3), call the existing
   `lockWalletForUpdate` / `ensureAccount` helpers — do not hand-roll inserts.

**Acceptance criteria**
- Flag off → signup is `pending` (unchanged). Flag on → `approved`.
- Re-approving an already-approved member sends **no** second email (the guard from
  `member-approval-guard` short-circuits before the notification fires).
- The approve path's `customer:approve` gate is unchanged and still enforced first.
- The flag resolves end-to-end (this is the seam's first real use — prove it, don't assume
  it).

**Verification commands**
- `pnpm typecheck` · `pnpm --filter @agora/chrono-api rls:proof`

**Out of scope:** UI.

**Execution start point:** read `apps/chrono-api/src/modules/member/routes.ts:162-200`
(the existing approve/reject handlers) before touching them.

---

## Phase 2 — Portal + dashboard read routes

**Files to update**
- `apps/chrono-api/src/modules/member/portal-routes.ts` — add
  `GET /me/onboarding`.
- `apps/chrono-api/src/modules/member/routes.ts` — add `GET /pending-count`.

**Step-by-step tasks**
1. Add `GET /me/onboarding` to `portal-routes.ts`, resolving the member identity exactly
   as the existing `getMyMembership` handler does — do not re-derive it.
2. Add `GET /pending-count` to `routes.ts` (the `/member-profiles` router), gated
   `customer:read`, counting via `withTenant`.

**Acceptance criteria**
- The portal route returns only the calling member's own state — never another member's,
  never another tenant's.
- `pending-count` is gated `customer:read` and scoped to `c.var.tenant.tenantId`.

**Out of scope:** UI (Phase 3); the notification path (Phase 1).

**Verification commands**
- `pnpm typecheck` · `pnpm --filter @agora/chrono-api rls:proof`

**Execution start point:** copy the existing `getMyMembership` handler's session
resolution exactly — do not re-derive the member identity.

---

## Phase 3 — Portal home + staff badge

**Files to update**
- `apps/chrono-web/src/app/portal/page.tsx` (replace placeholder)
- `apps/chrono-web/src/app/dashboard/members/` (pending badge)

**Step-by-step tasks**
1. Rewrite the `portal/page.tsx` render into three distinct states (pending / rejected /
   approved). The data layer already exists — `getMyMembership` / `getMyWalletBalance` are
   already wired — so this is a render change, not a fetch change.
2. Use `exists: false` from the wallet route (not a null check) to drive the top-up prompt.
3. Add the pending-count badge to the dashboard members page.

**Acceptance criteria**
- Each of pending / rejected / approved renders a distinct, self-explanatory state.
- An approved member with a zero wallet sees a top-up prompt, not a blank balance.
- No raw HTML chrome introduced.

**Verification commands** — `pnpm typecheck` · `pnpm build`

**Execution start point:** read the current `portal/page.tsx` in full; it already wires
`getMyMembership` / `getMyWalletBalance`, so this is a rewrite of the render, not the data
layer.

---

## Phase 4 — E2E spec

**Files to update**
- `apps/chrono-web/e2e/tests/portal/customer-onboarding.spec.ts` (new)

**Step-by-step tasks**
1. Happy path: portal signup → pending state visible → staff approves → customer sees
   approved state with a provisioned wallet → can start a session.
2. Role gate: a `staff` user without `customer:approve` cannot approve; the portal
   `me/onboarding` route refuses a staff session.
3. Cross-tenant isolation: a member of tenant A cannot read tenant B's onboarding state
   or appear in tenant B's pending count.
4. Flag on: signup is immediately approved with wallet provisioned.

**Acceptance criteria**
- All four scenarios pass. Scenario 3 must fail if tenant scoping is removed from either
  new route — assert on both the portal read and the pending count.

**Verification commands**
- `pnpm --filter @agora/chrono-web e2e -- portal` — the script is `e2e`
  (`apps/chrono-web/package.json:10`), **not** `test:e2e`; `pnpm dev` must already be
  running (no `webServer` in the Playwright config).

**Out of scope:** perf testing; notification-delivery assertions (email transport is
mocked).

**Execution start point:** the nearest existing portal spec, if one exists; otherwise
plan A's fixture.

---

## Open Questions (developer to confirm)

1. **Decision 1 above is a product call, not a technical one.** I recommend keeping
   `pending` + adding the per-tenant auto-approve flag. If you would rather match
   agora's instant-access precedent globally and drop the approval step entirely, say so
   — it simplifies this plan considerably (Phases 1–2 shrink to provisioning only).
2. **Rejection reason** — add a `rejectionReason` text column to
   `chronoMemberProfile`, or leave rejection unexplained? A schema change makes this
   plan-first per `.ai/rules/database.md`; it is currently scoped out.
3. ~~Does a Chrono `contracts/extensions.ts` already exist?~~ **Resolved: yes**, at
   `apps/chrono-api/src/contracts/extensions.ts`, but both registries are currently
   **empty** (`buildFeatureFlagRegistry({})` / `buildModuleRegistry({})` at lines 19–20).
   So `chrono.autoApproveMembers` would be Chrono's **first** own feature flag. Phase 1
   therefore edits that existing file rather than creating one — and should verify the
   flag actually resolves end-to-end (the seam is wired but never exercised, so this is
   its first real use; `featureFlagRoutes(CHRONO_FEATURE_FLAGS)` in `routes/rpc.ts` should
   be confirmed to be passing the merged registry, not the default).
