# Chrono Growth Loop Hardening — Post-Launch Follow-ups

**Sessions:**
- Planning: wallet-topup-presets-branding [6a865f]
- Audit: wallet-topup-presets-branding [6a865f] (coordinating a fresh, independently-invoked
  `plan-auditor` subagent, 2026-09-06 — not self-audited by the planning session's own
  context; verdict: needs revision, fixes applied below)
- Implementation: email-theme-fixes-session (dispatched subagent, 2026-09-06)

## Source

The developer supplied a large product brief ("Two-Sided Player + Partner Growth System",
38 sections) asking for a from-scratch implementation plan for a player-discovery /
partner-acquisition growth loop for Chrono. Before drafting anything, a full read-only audit
was run (six parallel agents) against the live `apps/chrono-web` + `apps/chrono-api` code.

## Headline finding: the growth loop already shipped

The brief's core ask — "player searches for a cafe → not found → requests it → business sees
demand → joins/publishes" — is **already fully implemented**, per
`.ai/plans/chrono/archive/two-sided-growth-loop/README.md` (8 phases, all landed) and
`apps/chrono-api/AGENTS.md:329` ("The growth loop"). Re-building it would duplicate shipped,
tested work. Confirmed shipped:

| Piece | Where |
|---|---|
| `ChronoBusinessLeads` (platform-global, no RLS by design) | `apps/chrono-api/src/modules/business-lead/schema.ts:30` |
| `/discover` search + empty-state auto-invite flow, e2e-tested | `apps/chrono-web/src/app/(apex-marketing)/discover/*`, `apps/chrono-web/e2e/tests/discover/search-and-invite.spec.ts` |
| Anonymous directory read + lead capture, rate-limited | `GET/POST /public/discover/*`, `apps/chrono-api/src/modules/business-lead/routes.ts` |
| Tenant demand signal (`{count}`, no PII), admin-gated | `GET /rpc/growth/demand`, `growth:["read"]` permission |
| `DemandBanner` on dashboard Overview | `apps/chrono-web/src/components/dashboard/growth/demand-banner.tsx` |
| Onboarding checklist (7 steps) | `apps/chrono-api/src/modules/onboarding/contracts.ts:37` |
| Player identity (global `customer` + per-tenant `tenantMember` + Chrono's `ChronoMemberProfiles`) | correctly wired per `.ai/rules/business-app.md`'s documented pattern, both signup paths live |
| Landing-page registry (13 sections), draft/publish gate, theme presets | `apps/chrono-web/src/components/landing/registry.ts:141`, foundation's `landingRoutes()` |

**Recommendation: do not re-plan or rebuild any of the above.**

## Related plan — read before auditing this one

`.ai/plans/chrono/in-progress/tenant-experience-v2/README.md` (Planning:
`consolidate-customers-members-page [7ffb50]`; Implementation:
`email-theme-fixes-session`, dispatched subagent — **as of this plan's own audit pass,
2026-09-06, neither session is currently connected and the plan's feature worktree has not
diverged from `main`**, so nothing has actually landed yet). That plan already scopes and
phases:
- **JSON-LD structured data** (its Gap 2 / Phase 2) — do not re-plan here.
- **Analytics-vendor wiring** (its Gap 4) — explicitly deferred, blocked on a developer
  decision, and flagged as possibly a **deliberate** privacy-conscious non-goal (its own
  Open Question 3, citing `analytics.ts`'s "no PII in event props by design" comment).
- Dynamic open/closed status (its Gap 1) and QR/source attribution (its Gap 3).
- **Sitemap/robots.txt**: independently confirmed absent by this plan's own research
  (`apps/chrono-web` has no `sitemap.ts`, no `robots.ts`, no `application/ld+json` anywhere) —
  this resolves that plan's own Open Question 1. Relayed there, not duplicated as a phase
  here.

**Correction from this plan's audit pass (2026-09-06): the "zero file overlap" claim below
was FALSE as originally written.** This plan's original Phase 4 (multi-branch
`/public/venue-info`) and `tenant-experience-v2`'s Phase 1a (dynamic open/closed status) both
reshaped the exact same route/response/files. Resolved per developer decision: **merged into
one phase**, now owned entirely by `tenant-experience-v2`'s Phase 1a (see that file). This
plan's Phase 4 below is now a pointer, not independent content. Every other phase in this plan
has been re-checked and has no file overlap with that plan.

## Genuine gaps (this plan's scope)

1. **Two silently-unenforced FKs.** `ChronoSalePayments.walletTransactionId` and
   `ChronoVouchers.promoId` were left as bare `text` columns with a "TODO once the target
   table lands" comment (`pos/schema.ts:146-152`, `voucher/schema.ts:13-21`) — both target
   tables (`wallet`, `promo`) have since landed and the TODO was never closed.
2. **No branded 404.** No `not-found.tsx` exists anywhere in `apps/chrono-web/src/app`
   (confirmed via `find`) — an unknown/suspended/deleted tenant host falls through to
   Next.js's generic default 404, the single biggest "feels like Chrono software, not the
   partner's own site" failure.
3. **`hidePlatformBranding` is dead code.** `TenantFooter` accepts the prop
   (`marketing-chrome.tsx:358`) but no call site (`/`, `/about`, `/stations`) ever passes
   `true` — there is no tenant-facing setting wired to it.
4. **Multi-branch partners are underserved publicly.** `/public/venue-info` and the `rates`
   landing section read only the tenant's first active branch (`branch/routes.ts:218-220`) —
   a second branch has no public rates/contact presence at all.
5. **No lead-detail console.** A partner sees only a bare `{count}` from `growth:read` —
   never the actual business-name variant, city, or message a player typed. Deliberate for
   v1 (no PII surface was built), but it blocks a partner from acting on specifics.
6. **No post-lead follow-up.** A player who requests a missing cafe gets no notification
   when that business later joins and publishes — the loop captures demand but never closes
   it back to the requester.
7. **Demand signal is frozen at pre-signup.** `DemandBanner`'s count reflects only leads
   captured before/around signup and never reflects ongoing organic interest once a tenant
   is live; nor is it surfaced anywhere in the onboarding checklist itself.
8. **`company-inquiry` persists nothing.** `POST /public/company-inquiries` only emails
   `SUPPORT_INBOX_EMAIL` and discards the submission — no row, no audit trail if the email
   is lost.
9. **`ChronoLandingPages` (legacy module) is still actively queried** (`landing-page/routes.ts:31,77`,
   referenced by `business-lead/routes.ts:169`) even though its own dedicated `/rpc` route
   mount was replaced by the foundation's `landingRoutes()` (`rpc.ts:1416-1424`) — needs a
   scoped audit before deciding consolidate vs. keep.
10. **No discovery ranking tied to demand.** `/discover` results are strictly alphabetical
    (`business-lead/routes.ts:232`) — a business with high pre-signup demand gets no
    visibility boost once listed.

## Pass 1 — Workflow Analysis (gaps only)

- **Gap 1 (FKs).** Silent data-integrity risk only — no user-visible workflow, but a
  dangling `walletTransactionId`/`promoId` could corrupt a refund/void reconciliation report
  with no error surfaced anywhere.
- **Gap 2 (404).** A player mistypes a subdomain, or follows a stale link to a since-suspended
  tenant → sees Next's generic unbranded page → bounces, no path back into Chrono at all.
- **Gap 3 (branding toggle).** A partner who wants a fully white-label feel has no lever to
  pull — "Powered by Chrono" always shows regardless of intent.
- **Gap 4 (multi-branch).** A 2-branch partner's public site silently omits branch #2's
  rates/hours/contact — a player who wants branch #2 sees only branch #1's info with no
  indication a second location even exists on the public surface.
- **Gap 5 (lead detail).** An admin sees "3 players asked for your business" with zero
  actionable detail — cannot tell if it's the same player 3 times, or 3 different people, or
  which of their branches was implied by the requester's city.
- **Gap 6 (notify-me).** A player who requested a cafe has no way to know it joined unless
  they happen to search again — the loop's "close the loop" step is missing.
- **Gap 7 (frozen signal).** An admin who dismisses `DemandBanner` once never sees a fresh
  number even if new leads accrue post-publish (matches the component's own documented
  accepted trade-off — but the *broader* gap is no ongoing signal exists at all, dismissible
  or not).
- **Gap 8 (company-inquiry).** If the email provider silently fails, a genuine B2B inbound
  inquiry is lost with zero trace.
- **Gap 9 (legacy table).** No visible user-facing failure today, but a future editor change
  to one cascade without the other risks silently divergent behavior between the two landing
  configs.
- **Gap 10 (ranking).** A high-demand business that just joined is buried alphabetically among
  established listings — weakens the very incentive (visibility) that should reward joining
  promptly after a demand spike.

## Pass 2 — Technical Planning

Boundaries: gaps 1, 4, 5, 6, 8, 10 touch `apps/chrono-api` (schema/routes/permissions);
gaps 2, 3, 7 touch `apps/chrono-web` only; gap 9 is investigation-first. No gap requires a
new permission resource — gap 5's new read route reuses the existing `growth:["read"]` gate.
No gap weakens tenant isolation; gap 1's new FKs are both within the already-RLS-forced
`ChronoSalePayments`/`ChronoVouchers` tables. Gap 4's response-shape change is additive
(`{branch}` → `{branches: []}`) but is a **breaking response-shape change** for any existing
consumer — must audit every current caller of `/public/venue-info` before implementing.

## Phase Design

### Phase 1 — Close the two unenforced FKs (Gap 1)

**Files to update:** `apps/chrono-api/src/modules/pos/schema.ts` (**corrected by audit** — this
is where `chronoSalePayment.walletTransactionId` is actually defined, not `wallet/schema.ts`;
`wallet/schema.ts` itself needs no edit), `apps/chrono-api/src/modules/voucher/schema.ts`, new
migration.

**Step-by-step tasks:**
1. Run an orphan-row audit first: `SELECT count(*) FROM "ChronoSalePayments" WHERE
   "walletTransactionId" IS NOT NULL AND "walletTransactionId" NOT IN (SELECT id FROM
   "ChronoWalletTransactions")`; same shape for `ChronoVouchers.promoId` → `ChronoPromos`.
2. If orphans exist, null them out in a preceding data-fix migration — never silently drop
   rows.
3. In `pos/schema.ts`, import `chronoWalletTransaction` from `../wallet/schema` (confirmed
   no circular-import risk — `wallet/schema.ts` only imports `../shift/schema`) and add
   `.references(() => chronoWalletTransaction.id, { onDelete: "set null" })` to
   `chronoSalePayment.walletTransactionId`; delete the now-stale comment there claiming
   `wallet/schema.ts` doesn't exist yet. In `voucher/schema.ts`, import `chronoPromo` from
   `../promo/schema` (confirmed no cycle) and add
   `.references(() => chronoPromo.id, { onDelete: "restrict" })` to `chronoVoucher.promoId`.
4. `pnpm db:generate --name add-sale-payment-wallet-fk-and-voucher-promo-fk`.

**Acceptance criteria:** both columns are real FK constraints in generated SQL; zero orphaned
rows remain; `pos/service.ts` and `voucher/routes.ts` still compile unchanged.

**Verification commands:** `pnpm typecheck`; `pnpm db:migrate`;
`pnpm --filter @agora/chrono-api rls:proof`.

**Out-of-scope:** any other module's forward-reference TODOs not already identified here.

**Execution start point:** the orphan-audit `SELECT`s, run against a real environment before
touching `schema.ts`.

### Phase 2 — Branded 404 for unknown/suspended/terminal tenant hosts (Gap 2)

**Files to update:** new `apps/chrono-web/src/app/not-found.tsx`. No helper change needed —
**corrected by audit**: `getPublicBranding()` already lives at
`apps/chrono-web/src/lib/branding.ts` (not `lib/tenant.ts`) and is already called from 5+
surfaces, confirmed reusable as-is.

**Step-by-step tasks:**
1. Build `not-found.tsx` (Next.js App Router convention, server component) calling
   `getPublicBranding()` (works from host alone, independent of landing-page existence) so a
   404 still shows a resolvable logo/colors when available, else a neutral Chrono-branded
   fallback.
2. Keep copy generic enough that "never existed" and "suspended" are not distinguishable from
   the response — avoid a subdomain-enumeration oracle.
3. Compose from `agora/ui` primitives only (`Card`, `Button`) per
   `.ai/rules/component-first-ui.md` — no raw HTML.

**Acceptance criteria:** an unknown subdomain, a suspended tenant's public path, and a
deleted-tenant host all render this page, never Next's generic default; branding resolves
when available.

**Verification commands:** `pnpm typecheck`; manual check against a known-suspended test
tenant and a random nonexistent subdomain.

**Out-of-scope:** the *authenticated* suspended-session page
(`(tenant-landing)/suspended/page.tsx`) — already exists, unrelated.

**Execution start point:** read `(saas-landing)/page.tsx:1017-1021` (current `notFound()`
call site) to confirm no other call site needs updating.

### Phase 3 — Wire `hidePlatformBranding` to a real tenant setting (Gap 3)

**Files to update:** `apps/chrono-web/src/components/landing/marketing-chrome.tsx`,
`packages/agora/src/core/db/schema/tenant.ts` (`TenantBrandings` — new column, **not** the
landing-page config, see locked decision below), `apps/chrono-web/src/lib/branding.ts`
(`getPublicBranding()`), the branding settings page
(`apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/branding/page.tsx`), and all
7 confirmed `<TenantFooter>` call sites: `(saas-landing)/page.tsx`,
`(saas-landing)/about/page.tsx`, `(tenant-landing)/stations/page.tsx`, `login/layout.tsx`,
`staff-auth-chrome.tsx`, `portal-auth-chrome.tsx`, `member-gate.tsx`.

**Locked decision (resolved by audit — Open Question 1 answered directly):** neither
`TenantBrandings` (`packages/agora/src/core/db/schema/tenant.ts:67-96`, read in full) nor the
landing-page config (`landingConfigSchema`, `.strict()`, no spare field) has an unused
boolean — a new field is required either way. Put it on **`TenantBrandings`, not the landing
draft/publish config**: `TenantBrandings` is what `getPublicBranding()` already reads, applies
**instantly** (no draft/publish gate), and is what every one of the 7 real `<TenantFooter>`
call sites already resolves through — several of which (login, staff/portal auth chrome,
member gate) render no landing sections at all and would need bespoke plumbing to reach a
value gated behind an unrelated publish flow.

**Step-by-step tasks:**
1. Add a nullable boolean column to `TenantBrandings` (default `false`/unset = current
   behavior, branding always shown).
2. Surface a toggle in the branding settings page, gated `landingPage:manage` (existing
   permission) — applies immediately, no publish step, matching how every other
   `TenantBrandings` field behaves.
3. Pass the resolved value into `TenantFooter`'s existing `hidePlatformBranding` prop at
   **all 7** call sites listed above, not just `/`, `/about`, `/stations`.

**Acceptance criteria:** toggling the setting hides/shows "Powered by Chrono" immediately
(no publish step) across all 7 surfaces; default is `false` (unchanged current behavior).

**Verification commands:** `pnpm typecheck`; e2e: toggle on → footer branding absent on `/`
and on `/login`.

**Out-of-scope:** hiding platform branding from staff-facing dashboard chrome (the
authenticated `/dashboard/*` surface itself, as opposed to its auth/login chrome).

**Execution start point:** the `TenantBrandings` schema addition in
`packages/agora/src/core/db/schema/tenant.ts`.

### Phase 4 — MERGED into `tenant-experience-v2`'s Phase 1a (Gap 4)

**Status: merged, 2026-09-06, per developer decision.** This phase originally reshaped
`GET /public/venue-info` for multi-branch support — the audit found `tenant-experience-v2`'s
Phase 1a (dynamic open/closed status) reshapes the exact same response, in the exact same
files. Rather than two independent reshapes of one route, the developer chose to merge them:
`tenant-experience-v2`'s Phase 1a now ships `{branches: [{...fields, hoursConfig,
computedStatus}]}` in one combined change. See
`.ai/plans/chrono/in-progress/tenant-experience-v2/README.md`, Phase 1a, for the actual
Files/Tasks/Acceptance Criteria/Verification Commands.

No independent phase exists here anymore. Confirmed by audit and carried into that phase:
`/public/stations` (`station/routes.ts:301+`) already returns all active branches with no
`.limit(1)` — it does not share this bug and needs no fix.

### Phase 5 — Lead-detail console for partners (Gap 5)

**Files to update:** `apps/chrono-api/src/modules/business-lead/routes.ts` (new
`GET /rpc/growth/leads`), `business-lead/contracts.ts`, new
`apps/chrono-web/src/app/(tenant-admin)/dashboard/growth/page.tsx`, `agora/ui` `DataTable`
stack per `.ai/rules/admin-table.md`.

**Step-by-step tasks:**
1. New route, `growth:read`-gated (existing permission, admin-only, unchanged), paginated,
   returns `{businessName, city, message, createdAt}` per matching lead — **never**
   `requesterCustomerId` or any derivable PII, matching the existing no-PII precedent on
   `GET /rpc/growth/demand`.
2. Dashboard page using the standard `DataTable`/`DataTableToolbar`/`DataTablePagination`/
   `useListQuery` stack per `.ai/rules/data-listing.md` — list state in the URL.
3. Link from `DemandBanner` ("N players asked" → "View details").

**Acceptance criteria:** an admin sees the actual lead rows; a non-admin staff member is
403'd and sees no link; no PII field is ever present in the response.

**Verification commands:** `pnpm typecheck`;
`pnpm --filter @agora/chrono-api test:permissions` (gate test must fail if `growth:read` is
stripped); new e2e covering happy path + role gate + cross-tenant isolation.

**Out-of-scope:** any write action on a lead (dismiss/archive).

**Execution start point:** re-read `business-lead/routes.ts`'s existing
`GET /rpc/growth/demand` handler in full to copy its normalization/matching logic exactly.

### Phase 6 — Post-lead "we'll notify you" follow-up (Gap 6)

**Files to update:** `apps/chrono-api/src/modules/business-lead/schema.ts` (add nullable
`notifiedAt`), new `business-lead/service.ts` or extend `routes.ts`,
**`packages/agora/src/core/server/routes/landing.ts`** (**added by audit** — this file's
`LandingRoutesOptions` currently only accepts a `permission?:` field (line 31); there is no
publish hook of any kind, and Chrono cannot mount a competing `/landing-page/publish` route
alongside it — Hono would silently shadow one, per `rpc.ts:1418-1421`'s own comment that the
foundation route *replaces* Chrono's legacy mount. This phase requires adding a new
`onPublish?: (tenantId: string) => Promise<void>` option to this **foundation** file, a
legitimate extension-seam change).

**Step-by-step tasks:**
1. Reuse the existing `EmailSender` provider (`packages/agora/src/core/server/providers/email/`)
   — no new infra.
2. Add `onPublish` to `LandingRoutesOptions`; call it from `POST /landing-page/publish` after
   the publish write commits. **Failure semantics must match the file's own `recordAudit`
   precedent**: the hook must be fire-and-forget / best-effort and must never roll back or
   block the publish itself, exactly as `recordAudit` already is documented to behave in that
   file.
3. Chrono's `onPublish` implementation runs the same normalized-name match
   `GET /rpc/growth/demand` already uses; for every matching lead with a non-null
   `requesterCustomerId` and no prior notification, email that customer.
4. Mark notified leads so a republish doesn't spam the same player twice.

**Acceptance criteria:** a signed-in player who submitted a lead gets exactly one email when
that business later publishes; an anonymous lead never triggers an email attempt.

**Verification commands:** `pnpm typecheck`; integration test asserting one send per matched,
previously-unnotified lead on publish.

**Out-of-scope:** SMS/push channels; notifying on any event other than first publish.

**Execution start point:** locate the exact publish route handler
(`packages/agora/src/core/server/routes/landing.ts`'s `POST /landing-page/publish`) for the
correct hook point.

### Phase 7 — Onboarding checklist surfaces the demand count (Gap 7, partial)

**Files to update:** `apps/chrono-api/src/modules/onboarding/contracts.ts`,
`onboarding/service.ts`, the dashboard onboarding-checklist card component.

**Step-by-step tasks:**
1. Do not add an 8th completable step (all existing probes are binary "does X exist"; a
   demand count isn't completable). Instead surface it as inline context next to the
   relevant setup steps.
2. **Two landmines identified by audit, both must be avoided:**
   (a) `resolveOnboardingState()`'s return value is parsed against the foundation's plain
   (non-strict) `onboardingChecklistStateSchema.parse()`
   (`packages/agora/src/core/contracts/onboarding.ts:135-146`) — Zod silently strips any
   unrecognized key on parse, so threading a Chrono-specific `demandCount` field through this
   shared function will be **silently dropped**. Do not extend that parse call; instead have
   the dashboard card fetch the count via a separate, already-existing call to
   `GET /rpc/growth/demand`, client-side, alongside the checklist fetch.
   (b) `resolveOnboardingState()` runs inside an already-open `withTenant(tenantId, tx)`
   transaction; its own `inviteStaff` probe comment (lines 93-98) warns that opening a second
   connection (e.g. a fresh `adminDb` call, which is what the existing demand-count logic
   uses) while `tx` is open **deadlocks** under the enforced e2e harness. Since this phase
   avoids threading the count through `resolveOnboardingState()` at all (per 2a), this
   deadlock risk does not apply — but do not "simplify" later by merging the two calls
   without re-checking this.
3. Keep the permission boundary: only render the number when the viewer holds `growth:read`
   (admin); a staff viewer sees generic encouragement copy with no number.

**Acceptance criteria:** admin sees the live count inline; staff sees no number; dismissal
reuses the existing `tenantOnboardingDismissal` mechanism unchanged.

**Verification commands:** `pnpm typecheck`; unit test asserting the count is omitted from
the API response for a non-admin role.

**Out-of-scope:** changing the checklist's step list or completion probes; the fully "ongoing,
not just pre-signup" version of this signal (that needs real analytics — see
`tenant-experience-v2`'s Gap 4, not this plan).

**Execution start point:** read `onboarding/service.ts:18-75`'s `resolveOnboardingState()` in
full before touching it.

### Phase 8 — Minimal persistence for `company-inquiry` (Gap 8)

**Files to update:** new `apps/chrono-api/src/modules/company-inquiry/schema.ts`,
`company-inquiry/public-routes.ts`.

**Corrected by audit — the original problem framing was wrong.** The current route does
**not** silently discard a failed send: it currently **throws** (a visible error to the
caller) on a missing inbox env var or a send failure — it is not "best-effort" the way
`business-lead`'s fire-and-forget pattern is. The real, narrower gap: on a **successful**
send, no row is ever written, so there's no queryable record of what was submitted, no
dedup, no future admin-UI possibility.

**Step-by-step tasks:**
1. Add a platform-global table (not tenant-scoped, not in `APP_TENANT_TABLES` — same
   treatment as `ChronoBusinessLeads`) storing the fields the existing Zod schema already
   accepts.
2. Insert the row **first, unconditionally, before attempting the email send.**
3. **Locked decision on failure contract:** persistence does not change the existing
   caller-visible failure behavior — if the email send still fails after the row is
   persisted, the route still throws/500s to the caller exactly as it does today (this is a
   deliberate choice per `.ai/rules/feature-planning.md`'s CRUD & Feedback Contract: don't
   silently swallow a failure the caller currently sees). The improvement is that the
   submission is no longer lost even when that failure occurs — it's recoverable from the
   new table regardless of the email outcome.
4. No read route in this phase — audit-trail fix only, not a new admin surface.

**Acceptance criteria:** every submission persists a row regardless of email outcome; the
caller-visible response/error behavior on a failed send is unchanged from today.

**Verification commands:** `pnpm typecheck`; `pnpm db:generate --name add-company-inquiry-table`;
integration test simulating an email-provider failure, asserting the row still exists.

**Out-of-scope:** an admin UI to read these rows (separate future phase if wanted).

**Execution start point:** read `company-inquiry/public-routes.ts` in full before inserting
the row.

### Phase 9 — `ChronoLandingPages` consolidation audit (Gap 9)

**Files to update:** none confirmed yet — investigation-only phase.

**Starting finding from audit (strengthens the case for consolidation):** the staff editor
route `landingPageRoutes()` (the GET/PATCH for `chronoLandingPage`) is **never
imported/mounted anywhere** in the codebase — confirmed via grep across `app.ts` and
`rpc.ts`; only `getPublicLandingPageContent`, the read-only helper, is actually used
(`app.ts:647`). The staff editor is fully dead/unreachable code today; only the public read
of frozen legacy data survives. Start the audit from this finding, not from scratch.

**Step-by-step tasks:**
1. Trace every call site of `chronoLandingPage` (`landing-page/routes.ts:31,55,77`,
   referenced from `business-lead/routes.ts:169`) to determine which fields are still
   load-bearing vs. superseded by the foundation's `TenantLandingPages`.
2. Decide: consolidate (migrate any still-needed fields, then drop the table and the dead
   `landingPageRoutes()`) vs. leave as-is with documented rationale.
3. Write the consolidation migration, if chosen, as a separate later phase after developer
   review of the audit's findings.

**Acceptance criteria (for the audit itself):** a written finding stating exactly which
fields are dead vs. live, with a recommendation.

**Verification commands:** none (read-only phase).

**Out-of-scope:** writing the actual consolidation migration in this phase.

**Execution start point:** read `landing-page/routes.ts` and `business-lead/routes.ts:150-200`
in full.

#### Phase 9 findings (2026-09-06 audit pass)

**Call-site trace, complete.** Every reference to `chronoLandingPage` (the `ChronoLandingPages`
table) traced:

- `landingPageRoutes()` (`landing-page/routes.ts:26`, GET/PATCH `/landing-page`, the staff
  content editor) — **confirmed 100% dead/unreachable code**, not just "unused" but
  *unreachable by construction*: `apps/chrono-api/src/routes/rpc.ts:1418-1425`'s own comment
  explains the foundation's `landingRoutes()` is mounted at the exact same path
  (`/rpc/landing-page`) and would silently shadow Chrono's own factory if both were mounted —
  so `landingPageRoutes()` was deliberately never wired in. This was a considered decision when
  the foundation's editor landed, not an oversight later. Confirmed via the web side too: the
  live editor page (`apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/landing-page/page.tsx`)
  calls `api.rpc["landing-page"].$get()`/`.$patch()`/`.publish.$post()`/`.unpublish.$post()` —
  every one of those resolves to the **foundation's** route, never Chrono's own. No web caller
  of the dead factory exists anywhere.
- `getPublicLandingPageContent()` (`landing-page/routes.ts:75`, read-only, mounted at
  `GET /public/landing-page` via `app.ts:652`) — **live**, the only surviving consumer of the
  table. Its return value is merged client-side (`apps/chrono-web/src/lib/landing.ts`'s
  `legacyLayer()`) as the **lower-precedence** layer under the foundation's published snapshot.
- `business-lead/routes.ts:172`'s mention of `ChronoLandingPages` — **doc comment only, not a
  code reference**. It explains why the public discovery directory checks the foundation's
  `tenantLandingPage.published` instead of this legacy table (publishing the NEW editor is the
  consent signal; the legacy table predates that decision and was never such a signal). No
  actual query touches `chronoLandingPage` from that module.

**Field-by-field, of `ChronoLandingPages`' six own columns** (traced through
`getPublicLandingPageContent()` → `apps/chrono-api/src/app.ts:652` → `apps/chrono-web/src/lib/landing.ts`'s
`legacyLayer()` → the two page components that destructure `getTenantLanding()`'s result):

| Column | Status | Where it's actually read |
|---|---|---|
| `heroTagline` | **Live** | `legacyLayer()` → `hero.title` |
| `aboutBody` | **Live** | `legacyLayer()` → `about.body` |
| `ctaLabel` / `ctaHref` | **Live** (paired) | `legacyLayer()` → `hero.primaryCta` |
| `contactOverride` | **Live** | `legacyLayer()` → `contact.phone` fallback |
| `amenitiesBody` | **Dead** | Present in the `LegacyContent` TS type and round-trips over the wire in `content.amenitiesBody`, but `legacyLayer()` never reads it and no component references it anywhere in `apps/chrono-web`. Confirmed via grep: the only match for `amenitiesBody`/`amenities` in `apps/chrono-web/src` is the type declaration itself. |

**One more dead field found, NOT a `ChronoLandingPages` column but computed by the same
function**: `getPublicLandingPageContent()`'s `hasStations` (a separate `ChronoStations` query,
folded into the same response) is threaded all the way through
`apps/chrono-web/src/lib/landing.ts`'s `TenantLanding.hasStations` — but neither
`(saas-landing)/page.tsx` nor `(saas-landing)/about/page.tsx` ever destructures it. Dead at the
consuming end, though the underlying query is cheap.

**Also dead by extension**: `updateLandingPageSchema`/`UpdateLandingPageInput`
(`landing-page/contracts.ts`) exist only to validate the dead `landingPageRoutes()` PATCH body —
no other caller.

**Recommendation:** consolidate, not leave-as-is — but as a separate, later phase (per this
phase's own out-of-scope line), not bundled into this one:

1. Migrate the five live columns' *behavior*, not necessarily the storage, into the
   foundation's `landingConfigSchema` cascade as first-class fields (or keep the legacy-layer
   merge indefinitely if a real migration of existing tenant data is judged not worth it — a
   developer call, not an engineering constraint).
2. Drop `amenitiesBody` immediately whenever that migration lands — zero consumers, zero risk,
   no data-migration question (nothing reads it, so nothing needs to keep reading it).
3. Delete `landingPageRoutes()`, its route mount comment, and `updateLandingPageSchema`/
   `UpdateLandingPageInput` — dead code with a zero-risk removal (never mounted, so removing it
   changes no runtime behavior).
4. Drop `hasStations` from `getPublicLandingPageContent()`'s return and `TenantLanding` — dead
   at every consumer.
5. Only once 1–4 are decided and (if applicable) existing tenant data is migrated, drop the
   `ChronoLandingPages` table itself and its schema file.

This finding does not change the recommendation to keep `ChronoLandingPages`' live columns
functioning today — nothing here is broken, and the legacy/new-editor precedence order
(`apps/chrono-web/src/lib/landing.ts`'s own doc comment) is correct as documented. The
consolidation is a cleanup opportunity, not a bug fix.

### Phase 10 — Discovery ranking by demand signal (Gap 10)

**Files to update:** `apps/chrono-api/src/modules/business-lead/routes.ts` (`GET
/public/discover/businesses` ordering).

**Step-by-step tasks:**
1. Change `orderBy(asc(base.organization.name))` (`business-lead/routes.ts:233` — **corrected
   by audit**, was cited as line 232, negligible drift) to a compound order: demand-count
   descending (computed the same normalized-match way `GET /rpc/growth/demand` already does,
   across all listed tenants in one query), then alphabetical as tiebreaker.
2. Cap the ranking boost concretely (e.g. top 3 slots by demand, remainder alphabetical) so
   one popular business doesn't crowd out the rest of a small directory.

**Acceptance criteria:** businesses with more matched pre-signup leads appear earlier,
provable via a query test with fixture data; alphabetical order preserved as tiebreak;
zero-demand tenants (the common case today) see unchanged ordering.

**Verification commands:** `pnpm typecheck`; unit test on query ordering with fixture leads
across 3+ tenants.

**Out-of-scope:** any ranking signal beyond demand count (ratings, recency, distance).

**Execution start point:** read `business-lead/routes.ts:200-240` (current directory query)
in full before modifying `orderBy`.

## Explicitly Out of Scope For This Plan

- Everything already shipped (see "Headline finding" table).
- JSON-LD structured data, sitemap.xml, robots.txt, analytics-vendor wiring, dynamic
  open/closed status, QR/source attribution — all owned by `tenant-experience-v2`
  (see "Related plan" above). Do not re-plan these here even if this plan's audit is picked
  up before that one's.
- Fuzzy/duplicate lead-name matching — the code's own comment documents this as a deliberate
  first-ship choice, not an oversight.
- Cross-tenant aggregate wallet/loyalty player view, any social/follow/review/leaderboard
  feature — never requested as a verified gap, explicitly out of scope per the source brief.

## Open Questions For Audit — ALL RESOLVED (2026-09-06 audit pass)

1. **Resolved.** Neither `TenantBrandings` nor the landing-page config had an unused boolean
   — a new field is required; locked to `TenantBrandings`, see Phase 3.
2. **Resolved.** Real callers of `/public/venue-info` enumerated: `(saas-landing)/page.tsx`,
   `(saas-landing)/about/page.tsx`, `lib/venue.ts`, `components/landing/registry.ts`,
   `components/landing/tenant-sections.tsx`, `e2e/run.ts` — carried into
   `tenant-experience-v2`'s Phase 1a, which now owns this change (see Phase 4 above).
3. **Resolved.** `/public/stations` does **not** share the bug — it already returns all
   active branches with no `.limit(1)`. No scope growth.
4. **Resolved.** Relayed: confirmed via dedicated grep that `sitemap.ts`/`robots.ts` do not
   exist anywhere in `apps/chrono-web`. Directly answers `tenant-experience-v2`'s own Open
   Question 1.

**One additional finding from this audit pass, not a pre-existing open question:** this
plan's original claim of "zero file overlap" with `tenant-experience-v2` was false — Phase 4
collided with that plan's Phase 1a on the same route/files. Resolved by developer decision:
merged (see Phase 4 and the "Related plan" section above). Every other phase was re-checked
and has no overlap.
