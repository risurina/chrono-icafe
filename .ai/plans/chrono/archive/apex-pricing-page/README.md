# Chrono — `apex-pricing-page` (standalone `/pricing` route)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Depends on:** `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first —
that plan creates the `(apex-marketing)` route group and its shared layout
(`MarketingHeader`/`MarketingFooter`, no tenant gating) this page's content sits inside.

**Status:** Accepted 2026-09-05, in `ready/`. Open questions 1-3 (CTA target, future
live-catalog endpoint, per-tier feature-claim accuracy) stand as documented — question 3
specifically should be checked against what Chrono actually ships before publishing.

## Why a standalone route, not the existing `/#pricing` anchor

The current apex marketing site is one long-scroll page
(`(saas-landing)/page.tsx`) with a `Pricing` nav entry pointing at the `/#pricing`
anchor section on that page. Breaking pricing out into its own `/pricing` route is a
**deliberate developer call**, made explicitly during this planning pass, and is a
conscious departure from that one-page pattern — not something this plan is
independently arguing for. `apex-marketing-shell` repoints the nav's `Pricing` entry
from `/#pricing` to `/pricing`; the existing home-page anchor section is left as-is
(out of scope here — see below).

---

## Pass 1 — Workflow Analysis

**Who uses it:** a prospective tenant (cafe owner) evaluating Chrono, on any host
(apex or a tenant subdomain — the marketing chrome renders identically everywhere, same
as `download`/`support`). Not tenant-scoped, not authenticated.

**Workflow:** visitor opens `/pricing` → sees three rollout tiers (Starter / Gaming
Lounge / Multi-Branch) each with a feature checklist → reads an upgrade-path callout and
a pricing FAQ → clicks "Request Private Demo" on any tier, which goes to `/support`
(this is a demo-gated pricing model, not self-serve checkout — see "Data source"
below) or `/sign-up` for a tenant ready to start directly. No account, no session, no
tenant context required to view the page itself.

**Failure cases:** none beyond a normal page render — this is static content with no
external fetch, no form, no submission. State this explicitly rather than inventing
failure modes that don't exist.

**Audit / notifications:** none. Pure read-only public content; nothing mutates.

---

## Pass 2 — Technical Planning

**Data source — static copy, not a live catalog read (decide/confirm with developer):**
No public, unauthenticated "read the plan catalog" endpoint exists anywhere in this
codebase today. `packages/agora/src/commerce/billing/index.ts` exports a server-only
`PLANS` map (code-defined entitlements, not presentation copy), and a separate
platform-admin-only `plan` DB table (`.ai/rules/rbac.md`'s `plan` resource,
`/rpc-admin/plans`) overlays commercial/presentation metadata for internal admin use —
neither is exposed publicly today, and building one is real foundation-level scope (a
new public read route, likely `agora/server`-side, shared by any future business app),
not something this single-page phase should silently take on.

This is a reasonable phase boundary because oikos's own **live production** pricing
page (read during this planning pass, see below) is itself demo-gated with **no real
dollar figures at all** — three tiers, each ending in "Request Private Demo," no
self-serve checkout. Static marketing copy fully matches that real-world shape; there
is no live number that would drift out of sync if hardcoded. Flagged as an explicit
Open Question below in case the developer wants real numbers later.

**Where it lives:** `apps/chrono-web` only. No `apps/chrono-api` route, no new table:

- **No new tenant table, no `APP_TENANT_TABLES` entry, no RLS impact.** This phase makes
  zero schema change — `rls:proof` does not apply, stated explicitly so it isn't
  mistaken for an oversight.
- **No `/rpc` route, no permission gate.** The content is public and identical for every
  visitor; a static Server Component is the whole surface.

**Where it renders:** `apps/chrono-web/src/app/(apex-marketing)/pricing/page.tsx` — a
new route in the `(apex-marketing)` group (see `apex-marketing-shell`). Content only —
no header/footer, `PageShell`, or nav of its own; the group `layout.tsx` supplies those.

**Design reference (read during this planning pass, for layout/UX/copy only — never
ported, per this repo's "improve, don't port oikos" rule):**
`/Users/risurina/karta/karta-tenant/apps/chrono-web/src/app/(landing)/pricing/page.tsx`.
Its actual structure:
- A hero: eyebrow "Pricing", headline, one paragraph of copy, a single "Request Private
  Demo" CTA (→ `/support` in the reference), and a decorative side panel ("Rollout
  Paths" stat card).
- Three pricing-tier `Card`s in a row: **Starter Cafe** (single-branch), **Gaming
  Lounge** (marked "Recommended"/featured), **Multi-Branch** (multi-location) — each
  with a name, one-line subtitle, a 5-item feature checklist (`Check` icon + text), and
  its own "Request Private Demo" CTA. A small italic disclaimer below the cards ("Final
  pricing may depend on implementation scope, rollout support, tenant count, and
  required modules").
- A two-column section: "When to upgrade to Multi-Branch" (three bullet triggers) next
  to a pricing-specific FAQ (5 Q&A pairs, distinct content from `/support`'s FAQ — do
  not merge the two).
- This is rebuilt fresh from `agora/ui` primitives and semantic tokens, not ported — the
  reference's raw HTML chrome and hardcoded `gold`/`zinc-950`/`#080806` literals are
  exactly what `.ai/rules/component-first-ui.md` and `.ai/rules/styling.md` prohibit
  here.

---

## Explicitly out of scope (and why)

- **A live `/public/plans` endpoint reading the real `plan` catalog.** Flagged as a
  future Open Question, not this phase — see "Data source" above. Building it would be
  separate, foundation-level scope shared by any business app, not a `chrono-web`-only
  page change.
- **Any billing/checkout logic.** Unrelated — real checkout already exists via
  `agora/billing` + `/sign-up`; this page never initiates a charge.
- **Editing the existing home-page `/#pricing` anchor section.** Left as-is; this plan
  does not touch `(saas-landing)/page.tsx`'s content, only adds a new standalone route
  and (via `apex-marketing-shell`) repoints the nav link that used to target the anchor.
- **Merging this page's FAQ with `/support`'s FAQ.** Distinct content, distinct pages,
  per the reference.

---

## Phase 1 — Public pricing page

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/pricing/page.tsx` — a static (non-async,
  no data fetch) Server Component composed only from `agora/ui` primitives: `Section`,
  `Card`/`CardContent`, `Badge` (for "Recommended" on the featured tier, replacing the
  reference's hand-rolled pill), `Button` (`asChild` + `Link` for each CTA), and plain
  text/heading primitives for copy. No raw `div`/`ul` chrome, no hardcoded hex colors —
  semantic tokens only (`text-muted-foreground`, `bg-card`, `border-primary/20`, etc.,
  as already used elsewhere in this app).
- New (co-located, same folder or `_data.ts`): a small local `const` module holding the
  three tiers' copy (name, subtitle, feature list, CTA target) and the FAQ entries — not
  a `packages/agora` contract (this is app-local static marketing copy, not a
  cross-app transport shape), and not a DB read (see "Data source" above).

**Step-by-step tasks:**
1. Write the tier/FAQ copy as local constants (mirror the reference's `plans`/`faqs`
   arrays' content, adapted to Chrono's real terminology already used elsewhere in this
   app — confirm feature-list wording against what stations/branches/shifts modules
   actually ship today rather than copying oikos's feature claims verbatim, since some
   ("Audit trail visibility", "Advanced staff permissions") may already differ from what
   Chrono-on-Agora actually offers at this stage).
2. Build the hero section: eyebrow + heading + one paragraph + a primary CTA `Button`
   linking to `/support` (matches the reference's actual live behavior — pricing is
   demo-gated, not self-serve; flagged as an Open Question below in case the developer
   prefers `/company/contact` instead).
3. Build the three-tier `Card` grid, each with its own CTA linking to `/support`, the
   featured tier marked with a `Badge`.
4. Build the "When to upgrade" + FAQ two-column section using the reference's actual
   copy content (adapted for accuracy per Task 1).
5. Add the italic pricing-disclaimer line below the tier cards.

**Acceptance criteria:**
- Visiting `/pricing` on any host (apex or a tenant subdomain) renders identically —
  three tiers, upgrade-path + FAQ section, no tenant-specific content.
- Every visible affordance is built from `agora/ui` primitives — no raw `div`/`button`
  chrome, no hardcoded hex colors, per `.ai/rules/component-first-ui.md` and
  `.ai/rules/styling.md`. Header/footer come from the group `layout.tsx`, not this page.
- No new DB table, no `APP_TENANT_TABLES` entry, no new permission resource, no `/rpc`
  route added, no external fetch on this page.
- Every tier CTA and the hero CTA resolve to a real route (`/support`, confirmed to
  exist once `apex-support-page` lands — do not ship this phase pointing at a 404).

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web dev`, then manually load `/pricing` on
  `APP_DOMAIN:3000` and on a tenant subdomain, confirming identical rendering.
- No `rls:proof` run required — this phase touches no schema/tenancy/RLS.

**Out of scope (phase-level, restates plan-level section above):** a live plans-catalog
data source; any checkout/billing wiring; the home-page `/#pricing` anchor content.

**Execution start point:** start with Task 1 (copy constants) since every other task
depends on it; the copy should be reviewed against what Chrono actually ships today
before the page is built around claims that aren't true yet.

---

## Open Questions (developer to confirm/override)

1. Pricing CTAs default to `/support` (matching oikos's actual live behavior — pricing
   is demo-gated). Should they instead go to `/company/contact`, or to `/sign-up`
   directly for a visitor ready to self-serve? Pick one target; do not scatter CTAs
   across all three inconsistently.
2. Should a future phase build a real `/public/plans` endpoint off the `plan` platform
   catalog so this page's tiers stay in sync with whatever admins configure there,
   instead of hand-maintained copy? Not addressed by this plan — flagged only.
3. The reference's feature-list claims per tier ("Audit trail visibility", "Advanced
   staff permissions", etc.) should be checked against what Chrono-on-Agora actually
   ships today (per `apps/chrono-api/AGENTS.md`'s module status) before publishing —
   this plan does not itself re-verify each claim, it only builds the page structure.

---

## After Implementation

Not yet — this plan is accepted and in `ready/`. Claiming `Implementation:` + committing
Phase 1 is the move to `in-progress/`, per `.ai/rules/feature-planning.md`.
