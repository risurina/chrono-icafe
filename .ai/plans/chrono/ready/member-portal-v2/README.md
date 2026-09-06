# Chrono Member Portal V2 — Gap Analysis & Delta Plan

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Source

The developer supplied a large product/UX/architecture spec ("CHRONO V2", 168 sections)
describing a full four-audience vision (global discovery, tenant public site, player/member
portal, partner portal) plus a mandatory pre-code audit. Two related plans already exist and
audited the **tenant-facing** side of this same spec family:

- `.ai/plans/chrono/in-progress/tenant-experience-v2/README.md` — tenant public landing page,
  discovery, SEO, branding.
- `.ai/plans/chrono/ready/growth-loop-hardening/README.md` — the player→business demand/growth
  loop, onboarding, 404, multi-branch public data.

This plan covers the parts of the new spec those two do **not**: the **member/player
portal** (`apps/chrono-web/src/app/(member-area)/member/*`) and the **partner-facing side of
the player↔business relationship** (lead detail, business claiming, announcements, support
routing). Three parallel read-only audits were run against the live code before writing any
phase (per the spec's own §12/§156 mandate and this repo's planning rules) — findings below.

## Headline finding: the spec's most alarming claim is not a bug

The spec's Phase 0 opens with a claim that production screenshots showed tenant branding
"GAMING LOUNGE" alongside "Acme Main Branch" reservations and "seed top-up" wallet
transactions, and treats this as an urgent P0 data-leak. **Audit verdict: not an issue.**
"Acme"-named entities and "seed top-up"/"seed credit purchase" strings exist **only** in
`apps/chrono-api/src/seed.ts` (a dev-only fixture script) — every production code path
(`wallet/routes.ts:217`, `credit/service.ts:253,417,438`, `payment/fulfilment.ts:107`,
`payment/service.ts:100,128`, `session/service.ts:325,346`) writes real, sensible strings
("Manual top-up", "Online payment", `Credit purchase: ${product.name}`, etc.). The developer
was almost certainly looking at a dev/seeded environment, not a production leak. **No phase
needed for this.** (One genuine, much smaller copy issue survives — see Phase 6.)

Two other spec claims also resolve cleanly on audit, with no phase required:

- **Wallet scope ambiguity (spec §40)**: `chronoWallet` (`wallet/schema.ts:11-33`) is
  `tenantId`-scoped with a unique `(memberId)` index — one wallet per member **per tenant**,
  by design, matching the foundation's per-tenant `tenantMember` model. This is already the
  correct, deliberate architecture (a player who joins two tenants gets two independent
  wallets) — not an open product decision to make.
- **Tenant isolation for wallet/reservation/session/membership/loyalty**: all five tables are
  in `APP_TENANT_TABLES` and every route audited goes through `withTenant` — confirmed intact,
  no exception found.

## What already works and needs no rebuilding

- **Global player identity across multiple tenants already exists at the data layer and
  partially in the UI.** `POST /portal/customer/apply` creates an independent `tenantMember`
  (and thus `ChronoMemberProfiles`) row per tenant, linked by `customerId` to one global
  `customer`. `apps/chrono-web/src/app/(member-portal)/portal/global-portal-home.tsx` already
  renders a "Your businesses" list (`GET /portal/customer/memberships`) with per-venue status
  and a link into each tenant's portal. The spec's §76-78 "My Gaming Spots"/business-switcher
  ask is **already mostly built** — see Phase 7 for the real remaining gap.
- **Reservation double-booking is already prevented server-side** — a DB unique constraint +
  `isUniqueViolation()` catch in `reservation/service.ts` returns `409
  RESERVATION_ALREADY_ACTIVE`. Only the frontend picker UI needs work (Phase 4).
- **Loyalty is a real, implemented ledger** (`loyalty/schema.ts`, tier computed server-side
  from `lifetimePoints`, unit-tested), not a UI placeholder.
- **Partner demand signal, onboarding checklist, discovery, landing registry** — already
  shipped, per the two related plans. Do not re-plan.

## Genuine gaps (this plan's scope)

| # | Gap | Severity | Where |
|---|---|---|---|
| 0 | Pending applicants see full wallet balance, loyalty tier/progress, and a "member since" date alongside the "pending approval" banner — contradictory UI | **P0** | `apps/chrono-web/src/app/(member-area)/member/page.tsx:72-178`, `profile/page.tsx:135-141` |
| 1 | Member nav is 10 items incl. a permanently-disabled dead "Leaderboard" entry; no page/route backs it | P1 | `apps/chrono-web/src/components/member/member-nav.config.ts:35-127` |
| 2 | Dashboard is a static always-same-order card list, not state-driven (no session vs. active session vs. upcoming reservation) | P1 | `member/page.tsx:64-222`, `MEMBER_DASHBOARD_CARDS` |
| 3 | QR "Connect" confirm screen shows station + branch name but **not rate or availability** before starting a session | P1 | `apps/chrono-web/src/app/(tenant-landing)/q/[token]/page.tsx`, `apps/chrono-api/src/modules/qr/public-routes.ts` |
| 4 | Reservation form is a generic datetime input + duration dropdown, not a discrete time-slot picker | P1 | `member/reservations/page.tsx:77-410` |
| 5 | Active session view has no realtime/polling — static until manual refresh, **by explicit prior plan decision** ("Realtime: none for members") | P2 — needs a developer decision, not just a build | `member/session/page.tsx`, `member/session/[id]/page.tsx` |
| 6 | Wallet/session transaction copy interpolates raw internal IDs into user-facing text (e.g. "Session cm3x...") | P2 (copy only) | `member/wallet/page.tsx:288`, `session/service.ts:325,346` |
| 7 | "My Gaming Spots" venue list has no live open/closed + availability per venue; no in-session business switcher (each venue is a separate subdomain session by design) | P2 | `global-portal-home.tsx`, `GET /portal/customer/memberships` |
| 8 | History is three separate tabs (Wallet/Credits/Sessions), not one unified Activity feed | P2 | `member/history/page.tsx:27-31,183-219` |
| 9 | No in-portal path to reach Chrono platform support — every error routes to "Contact the business," even for account/platform-level issues | P2 | `member-gate.tsx:18`, `member/page.tsx:79`, `member/settings/page.tsx:114` |
| 10 | No business-claiming/ownership-verification flow (a lead-generated business name can only become a tenant via ordinary signup, no verification step) | Future | `business-lead/routes.ts`, `onboarding` module |
| 11 | No tenant→player broadcast/announcement mechanism (only a platform-staff→tenant-admin announcement system exists — wrong direction) | Future | `packages/agora/src/core/contracts/announcements.ts` |
| — | Partner lead-detail console (bare `{count}`, no drill-in) | Already scoped | **Pointer**: `growth-loop-hardening` Gap 5 — do not duplicate, that plan owns it |
| — | Tenant-facing conversion/analytics dashboard | Already scoped, blocked | **Pointer**: `tenant-experience-v2` Gap 4 — do not duplicate |

## Phase design

### Phase 0 — Fix membership-state UI contradiction (P0, ready to implement)

**Files to update:**
- `apps/chrono-web/src/app/(member-area)/member/page.tsx`
- `apps/chrono-web/src/app/(member-area)/member/profile/page.tsx`

**Step-by-step tasks:**
1. Define the actual business rule with the developer before touching code (see Open
   Question 1 below) — this phase cannot start until that's answered, because "hide" vs.
   "show with a clearer caveat" are different UIs.
2. Once decided, gate the wallet balance card, `TierBadge`/loyalty progress bar, and
   "Member since" date on `chronoMemberProfile.applicationStatus === "approved"` (or the
   agreed alternative), on both `member/page.tsx` and `profile/page.tsx`.
3. For a pending/rejected applicant, replace the gated content with a clear state (e.g. "Your
   application is pending — wallet and rewards unlock once approved").

**Acceptance criteria:** a `pending` or `rejected` `tenantMember` sees no wallet balance, no
loyalty tier/progress, and no "member since" date; an `approved` member's experience is
unchanged.

**Verification commands:** `pnpm typecheck`; manual walkthrough of `/member` and
`/member/profile` as a pending test member (no schema/API change, so no `rls:proof` re-run
needed).

**Out-of-scope:** any change to `applicationStatus`/`tenantMember.status` enforcement itself
(e.g. blocking pending members from wallet/loyalty **API** routes) — that is a separate,
larger authorization decision (see Open Question 1) and not bundled into this display-only
fix unless the developer says otherwise.

**Execution start point:** read `member/page.tsx:64-222` and `profile/page.tsx:100-150` in
full, then make the smallest change satisfying the acceptance criteria above.

### Phase 1 — Navigation simplification

Collapse Session + Connect → **Play**; History (+ any Offers/Promos remnant) → **Activity**;
remove the dead **Leaderboard** entry entirely (not "coming soon" — spec §47 Option A, since
there's no near-term plan to build it); keep Profile/Settings menu-only as today. Rename
Dashboard → **Home** only if the developer confirms the terminology change (see Open
Question 2) — nav restructuring and renaming are separable and this phase should not stall
on the naming question.

**Files:** `apps/chrono-web/src/components/member/member-nav.config.ts` and every route this
consolidates (`member/session/`, `member/connect/`, `member/history/`, `member/promos/` if it
exists — confirm during implementation, don't assume).

Needs Pass 2 detail (exact merged route names, redirect handling for old bookmarked URLs)
before this moves to `ready/` — not yet concrete enough to implement.

### Phase 2 — State-driven Home dashboard

Add explicit dashboard states (no session / active session / upcoming reservation), each
its own layout branch, per spec §21-22. Reuse existing session/reservation queries already
fetched on `member/page.tsx` — this is UI branching, not new data.

Needs Pass 2 detail (exact state precedence when multiple are true, e.g. active session AND
an upcoming reservation) before `ready/`.

### Phase 3 — QR "Scan to Play" confirm screen

Add rate + current availability to the `/q/[token]` confirm screen before "Start," per spec
§26. Requires `apps/chrono-api/src/modules/qr/public-routes.ts` to include the station's rate
and availability in its token-resolution response (check whether `/public/stations` data is
already joinable here before adding a new query).

### Phase 4 — Reservation slot picker

Replace the datetime+duration form with a discrete slot picker (derive available start times
from the station's schedule/operating hours + existing reservations), per spec §32-34.
Backend concurrency guard already exists — this is frontend-only plus one new "available
slots for station X on date Y" read endpoint.

### Phase 5 — Active session live updates (BLOCKED on a developer decision)

The prior `reservations`-page code comment records an explicit decision: "Realtime: none for
members." The spec (§35, §90) wants live elapsed-time/charge/balance. Reversing that decision
means either wiring the existing realtime provider (`agora/realtime`) into the member session
view, or a lighter polling approach — a real architecture choice, not a mechanical build. See
Open Question 3. Do not start this phase until answered.

### Phase 6 — Wallet/session transaction copy cleanup

Strip raw IDs from server-generated reason strings (`session/service.ts:325,346` and
similar) — e.g. `` `Session ${id}` `` → a copy referencing the venue/date instead of a raw
CUID. Small, mechanical, no schema change.

### Phase 7 — Live status on "My Gaming Spots"

Add live open/closed + availability counts to each venue row in
`GET /portal/customer/memberships` / `global-portal-home.tsx`, reusing the existing public
`/public/stations`-style aggregation per tenant. **Same-session business switching is
out-of-scope** — each tenant is a separate subdomain/session by the platform's own
architecture (`.ai/rules/architecture.md`, no cross-tenant session), so "switching" stays
"link to the other venue's own portal session," matching what already exists.

### Phase 8 — Unified Activity feed

New `GET /portal/activity` aggregating wallet + credit + session + reservation events into
one paginated, sorted feed, replacing the three-tab history view. Genuinely new backend work
(cross-module aggregation query) — needs its own Pass 2 file/route plan before `ready/`.

### Phase 9 — In-portal support routing

Add a lightweight "Need help?" affordance that distinguishes venue-operational issues
(existing "contact the business" pattern, unchanged) from account/platform issues (new link
to Chrono support, reusing the apex `/company/contact` form or an equivalent in-portal
route). Small, mostly copy + one new link.

### Deferred to `future/` (not phases of this plan)

- **Business claiming/ownership verification** (spec §71) — a new trust/verification
  subsystem, meaningfully sized on its own; needs its own plan once prioritized.
- **Tenant→player announcements** (spec §135) — needs a notification-delivery decision
  (in-app only vs. email/push) before scoping; likely overlaps a future "notifications"
  plan already referenced in `apps/chrono-api/AGENTS.md`.

## Out of scope for this entire plan

- Everything already covered by `tenant-experience-v2` and `growth-loop-hardening` (tenant
  public site, discovery, SEO, lead-detail console, 404, multi-branch public data).
- Custom domains, advanced analytics, personalized offers, cross-business recommendations
  (spec §153) — explicitly future-phase in the spec itself.
- Any schema/RLS change — no phase in this plan currently requires one; if Phase 8's activity
  aggregation or Phase 3's QR response reshaping surfaces one during Pass 2, flag it before
  implementation.

## Resolved for implementation (2026-09-07, developer directed "implement")

Conservative defaults chosen where the developer did not specify further, so implementation
could proceed without guessing on anything security- or architecture-sensitive:

1. **Phase 0**: Option (a) — **hide** wallet balance, loyalty tier/progress, and "member since"
   entirely for a `pending`/`rejected` applicant (safer default than showing financial/status
   data pre-approval). The companion API-layer gate (blocking wallet/loyalty portal **routes**
   for non-approved members) is explicitly **not** included — per the plan's own carve-out,
   that is a separate, larger authorization decision and stays out of scope for this
   display-only fix.
2. **Phase 1**: Proceed with **structural consolidation only** (Session+Connect→one item,
   History merged, Leaderboard removed) — **no renames** (Dashboard/Session/History keep
   their current labels). Renaming is a product/copy decision that should not be made
   unilaterally.
3. **Phase 5**: **Deferred, not implemented in this pass.** Reversing "no realtime for members"
   is a real architecture decision (realtime provider vs. polling, cost/complexity) that
   should not be made without explicit developer sign-off. Left as `future/`-eligible; the
   existing static/manual-refresh behavior is unchanged.
4. **Scope check**: Phase 7 (venue-list live status) and Phase 9 (support routing) stay in
   this plan — they operate on this plan's own files (`global-portal-home.tsx`,
   `member-gate.tsx`, `member/settings/page.tsx`), not on `tenant-experience-v2`'s or
   `growth-loop-hardening`'s files. No overlap found; no move needed.

**Phases implemented in this pass:** 0, 1 (structural only), 2, 3, 4, 6, 7, 8, 9.
**Phase 5 explicitly excluded** — needs its own developer decision before it becomes a phase.

## Open questions (must be answered before the affected phase is `ready/`)

1. **Phase 0**: What should a pending/rejected applicant actually be able to see and do?
   Options: (a) hide wallet/loyalty/member-since entirely until approved, (b) show them but
   clearly labeled as inactive/preview, (c) something else. This also determines whether a
   companion API-layer gate (blocking wallet/loyalty portal routes for non-approved members)
   is warranted — today those routes have zero `applicationStatus` check, which may or may
   not be intentional.
2. **Phase 1**: Confirm the Dashboard→Home, Session→Play, History→Activity renames are
   wanted, or whether only the structural consolidation (fewer nav items) should proceed
   without a terminology change.
3. **Phase 5**: Confirm whether to reverse the standing "no realtime for members" decision,
   and if so, realtime provider vs. polling.
4. Confirm this plan's scope split against `tenant-experience-v2`/`growth-loop-hardening` is
   correct — in particular Phase 7 (live status on venue list) and Phase 9 (support routing)
   touch tenant-portal-adjacent code; flag if either should move to those plans instead.
