# Chrono — auto-create the Chrono membership profile on tenant join

**Type:** bug fix / gap closure in landed, shipped code. Not a new feature, no schema
change.

**Sessions:**
- Planning: algolia-search-provider-integration [10bb99]
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Reported symptom

On a tenant host (e.g. `isurina.chrono2.izur.com.ph/member`), a signed-in global
customer applies to join the business ("Join this business" → Apply) and, per the
developer's report, appears to stay stuck on that screen instead of landing in the
member portal with a visible "pending approval" status.

## What investigation found (read before touching any file)

Two independent "apply" actions exist and are **not wired together**:

1. **Foundation apply** — `ApplyForTenantPrompt.onApply()`
   (`apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx:17-31`) calls
   `applyForTenantMembership()` → `POST /portal/customer/apply`
   (`packages/agora/src/identity/customer-auth/index.ts:914-971`). This creates an
   **active** `tenantMember` row instantly (foundation design: instant access, no
   pending state — see `.ai/rules/business-app.md`, "Global customers"). Traced
   end-to-end: `useMemberSession()`/`useGlobalCustomerSession()`
   (`packages/agora/src/presentation/client/react.tsx:21-64`) are plain
   `useEffect`+`fetch`, no caching, so `location.reload()`
   (`apply-for-tenant-prompt.tsx:30`) correctly re-resolves the session and
   `MemberGate`'s `canApply` (`apps/chrono-web/src/components/member/member-gate.tsx:125`)
   flips to `false`. **The "stuck on Join this business" screen itself is not
   reproducible from this code path** — the join screen correctly exits once applied.
2. **Chrono's own membership apply** — `POST /portal/members/apply`
   (`apps/chrono-api/src/modules/member/portal-routes.ts:137-177`) is what actually
   creates the `ChronoMemberProfile` row carrying real `applicationStatus`
   (`pending`/`approved`/`rejected`, per the tenant's `chrono.autoApproveMembers`
   flag). **Nothing calls this after step 1.** `applyForMembership()`
   (`apps/chrono-web/src/lib/member/account.ts:38-42`) already exists as a client
   helper but has no caller anywhere in the join flow.

Consequence, confirmed by reading `GET /portal/members/me/onboarding`
(`portal-routes.ts:40-77`, line 59: `profile?.applicationStatus ?? "pending"`): a
member who only ever went through step 1 has **no `ChronoMemberProfile` row at all**.
The home page (`(tenant-member)/player/page.tsx:102-116`) and profile page
(`.../player/profile/page.tsx:139-144,204`) already render a correct-looking "pending
approval" card off that fallback value — but it's a fallback, not a real application.
**Staff can never approve it**: the tenant dashboard's Members list only shows
Approve/Reject for `profileId && applicationStatus === "pending"`
(`.ai/plans/chrono/archive/customers-members-merge/README.md`'s LEFT JOIN design), and a
step-1-only row has `profileId: null`. So the member is stuck showing "pending" forever
— not because the UI is broken, but because no real application was ever filed for
staff to act on. This is very likely what the developer observed and described as
"stuck".

**Explicitly ruled out**: an old, unrelated note in
`.ai/plans/chrono/archive/customers-members-merge/README.md` ("Main branch
auto-provisioning silently fails on `isurina.chrono2.izur.com.ph`") looked at first
like it might be the same live bug, re-surfacing on the same test tenant. It is not —
it is a separate, already-closed matter (see `.ai/plans/chrono/archive/
signup-default-provisioning/README.md`), unrelated to member apply/onboarding.

## Decisions (confirmed by the developer)

1. **Pending members keep full view access.** No new blocking gate — a pending
   member can browse the whole member portal exactly as today (`RouteGate` stays
   scoped to `requiresApproval` routes only, unchanged, currently just Promos). Only
   profile *edits* and approval-gated actions stay restricted, with a visible pending
   banner — this already matches shipped behavior on the home page and profile page,
   so **no gating changes are in scope**.
2. **Auto-create the Chrono profile on apply.** `ApplyForTenantPrompt.onApply()` must
   also call `applyForMembership()` right after the foundation apply succeeds, so a
   real `ChronoMemberProfile` row exists immediately (respecting
   `chrono.autoApproveMembers`) instead of the member only ever seeing a fallback
   "pending" value with nothing for staff to approve.

## Pass 1 — Workflow analysis

**Who:** a signed-in global customer (platform-wide `agora/customer-auth` identity)
applying to become a member of one tenant; secondarily, the tenant's `staff`/`admin`/
`owner` who approves/rejects membership applications (`customer:approve`/`:reject`,
unchanged).

**Workflow:** customer visits `{slug}.APP_DOMAIN/member`, sees "Join this business",
clicks Apply. After this fix: one click now performs both applies (foundation +
Chrono) in sequence, then reloads into the member portal showing a real "pending
approval" (or, if the tenant auto-approves, immediately-approved) status. The
applicant now shows up in that tenant's `/admin/members` list with a real
Approve/Reject action available to staff.

**Failure cases:**
- Foundation apply fails (validation/session error) → unchanged: existing
  `toast.error(error)` path, no reload, no Chrono apply attempted.
- Foundation apply succeeds but the Chrono apply call fails (network blip, unexpected
  500) → the member has already legitimately joined the tenant at the foundation
  level; do not block that. Log the failure and let the reload proceed — the member
  lands in the portal seeing the fallback "pending" value (today's behavior,
  unchanged) rather than being stuck on an error screen for something already
  succeeded. This is a deliberate best-effort call, not a silent-failure risk: the
  Chrono apply is idempotent and side-effect-free to retry, so a later profile
  page/home page load can be given a retry affordance in a future pass if this proves
  to matter in practice — out of scope here since it hasn't been reported as an issue.
- Cross-tenant: unaffected — both calls are tenant-scoped via the caller's own
  resolved `c.var.member`/`c.var.tenant`, never client input.

**Audit / notifications:** `POST /portal/members/apply` is already unaudited by
design ("Customer-initiated action" comment, `portal-routes.ts:175-176`) — unchanged.

## Pass 2 — Technical planning

**No schema, migration, RLS, or permission change.** Both endpoints already exist and
are already correctly gated/scoped. This is purely a missing client-side wiring step
plus one stale e2e comment/assertion update.

**Files to change:**
- `apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx`
- `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts`

**Out of scope:**
- Any change to `MemberGate`/`RouteGate` gating logic (per Decision 1 above).
- Any change to `packages/agora`'s foundation apply route — this stays business-
  neutral per `.ai/rules/business-app.md`; the fix lives entirely in Chrono's own
  client code.
- A retry affordance for a failed Chrono-apply-after-successful-foundation-apply —
  flagged above, not requested, not building it speculatively.
- The `customers-members-merge` LEFT JOIN/profile-less-row behavior itself — still
  needed and still tested (via the Members page's "Create customer" action), just no
  longer exercised by *this* particular e2e path once this fix lands.

## Phase 1 — Wire the Chrono apply into the join flow, update e2e

**Files to update**
- `apps/chrono-web/src/components/member/apply-for-tenant-prompt.tsx`
- `apps/chrono-web/e2e/tests/global-customers/apply-for-tenant.spec.ts`

**Step-by-step tasks**
1. In `apply-for-tenant-prompt.tsx`'s `onApply()`: after
   `applyForTenantMembership()` returns with no `error`, call
   `applyForMembership()` (`@/lib/member/account`, already exported, no new import
   path needed beyond adding it alongside the existing `applyForTenantMembership`
   import from `@/lib/customer-client`).
2. If `applyForMembership()` returns an `error`, `console.error` it (visibility for
   support/debugging) but do **not** `toast.error` or block — proceed to the existing
   `track(...)` calls and `location.reload()` unchanged, per the failure-case
   decision above.
3. Keep the two `track(...)` analytics calls exactly where they are (after both
   applies succeed or the second is best-effort-skipped, before reload) — no event
   name/payload changes.
4. In `apply-for-tenant.spec.ts`: update the comment at lines 64-68 — it currently
   asserts *why* the LEFT JOIN matters by stating "the applied customer has no
   chronoMemberProfile row"; that stops being true for this path once this phase
   lands. Rewrite the comment to say the applicant now has a real profile row via
   the wired-up Chrono apply, and that the profile-less-row LEFT JOIN case is instead
   covered by `customers-members-merge`'s own "Create customer" scenario (already
   landed, unaffected by this change — confirm, don't re-test it here).
5. In the same spec, after the `/admin/members` visibility assertion (~line 71),
   add one new assertion: the applicant's row shows an "Approve" action (it
   previously would not have, since `profileId` was null) — this is the concrete,
   new, testable behavior this phase adds.
6. Do the same edit for the second tenant (`slugB`) assertion block (~line 93-95) for
   consistency, or confirm one assertion in the flow is sufficient — prefer not
   duplicating the same check twice in one spec if the first occurrence already
   proves the mechanism; use judgement here and keep the spec readable.

**Acceptance criteria**
- Clicking Apply creates both an active `tenantMember` row and a
  `ChronoMemberProfile` row (`applicationStatus: "pending"`, or `"approved"` if the
  tenant's `chrono.autoApproveMembers` flag is on) in one user action.
- The member portal home page and profile page continue to show the correct status
  card exactly as before (no behavior change there — this was already correct).
- The tenant's `/admin/members` list now shows an Approve/Reject action for this
  applicant immediately after they apply (previously required a separate,
  never-triggered Chrono-side apply call).
- A transient failure of the Chrono apply call does not block the member from
  completing the join (foundation apply already succeeded) — verify by temporarily
  forcing `applyForMembership()` to reject and confirming `onApply()` still reaches
  `location.reload()`.
- No regression in the two existing `apply-for-tenant.spec.ts` scenarios (global
  customer applies to two tenants independently; tenant-only signup unaffected).

**Verification commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web e2e -- global-customers` (headed, needs `pnpm dev`
  running per `.ai/rules/rbac.md`'s e2e config note)
- Manually re-run `apps/chrono-web/e2e/tests/members/members.spec.ts` and
  `.../members/invite-customer.spec.ts` to confirm no regression (they exercise
  profiled rows already, per `customers-members-merge`'s Phase 3 notes).

**Out-of-scope** (repeated from Pass 2 for this phase specifically): no gating
changes, no schema changes, no retry-affordance UI for the best-effort failure case.

**Execution start point:** `apps/chrono-web/src/components/member/
apply-for-tenant-prompt.tsx` — read `onApply()` (lines 17-31) and
`apps/chrono-web/src/lib/member/account.ts`'s `applyForMembership()` (lines 38-42)
side by side before editing.

## Plan closure

Once Phase 1 lands and verifies, move this plan from `draft/` (or `ready/`/
`in-progress/`, whichever it has reached) to `.ai/plans/chrono/archive/
member-apply-profile-autocreate/README.md` per `.ai/rules/feature-planning.md`.
