# Chrono — `apex-marketing-shell` (route group + nav/footer wiring for the new apex pages)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Status:** Accepted 2026-09-05, in `ready/` — build first, everything else in this
batch depends on it.

**Depended on by:** `.ai/plans/chrono/ready/app-versions/README.md` (download),
`.ai/plans/chrono/draft/apex-support-page/README.md`,
`.ai/plans/chrono/draft/apex-company-contact/README.md`,
`.ai/plans/chrono/draft/apex-company-about/README.md`,
`.ai/plans/chrono/draft/apex-legal-pages/README.md`,
`.ai/plans/chrono/draft/apex-pricing-page/README.md` — every one of those plans needs
the route group and the nav/footer links this plan builds, and none of them may touch
`marketing-chrome.tsx` themselves (single-writer, to avoid six plans conflicting on one
shared file).

## Why this exists

Investigating the `app-versions` (PC-client download) plan surfaced a wider gap: the
developer wants Chrono's public apex site to also carry `/support`, `/pricing`,
`/terms`, `/privacy`, an apex "About IZUR", and an apex "Contact IZUR" — mirroring
`https://chrono.izur.com.ph/`. Two things already exist in this codebase that make most
of that straightforward, and one existing routing fact makes two of those pages need a
different path than their oikos equivalent:

- **The apex marketing site today is one long page**, `apps/chrono-web/src/app/
  (saas-landing)/page.tsx` (`PageShell > MarketingHeader, Main, MarketingFooter`), with
  anchor sections (`/#features`, `/#pricing`, `/#faq`). `apps/chrono-api/AGENTS.md`
  documents this explicitly: "the apex marketing page (`(saas-landing)/page.tsx`)."
  `MarketingHeader`/`MarketingFooter` already exist in
  `apps/chrono-web/src/components/landing/marketing-chrome.tsx` and are reused as-is by
  this plan — no new chrome components, only a new place to mount them.
- **`(saas-landing)/about` and `(saas-landing)/contact` are NOT apex pages** — an
  earlier plan note (`page-route-groups`) classified them as apex marketing pages, but
  a later plan (`tenant-landing`, archived) repurposed both into real, tenant-scoped
  features: `/about` is each tenant's own configurable landing section
  (`getTenantLanding()`, 404s with no tenant), `/contact` is a tenant's own public
  "submit an inquiry to this cafe" form (`POST /public/inquiries`). Confirmed live by
  reading both files. `apps/chrono-api/AGENTS.md`'s current text agrees: "each tenant's
  own landing page (`/about` on the tenant host)." So an apex "About IZUR" / "Contact
  IZUR" cannot reuse those paths — they get `/company/about` and `/company/contact`
  instead (developer's explicit choice, 2026-09-05).
- **A live bug found along the way**: `MarketingHeader`'s own nav ("About" →
  `/about`, "Support" → `/contact`) and its primary CTA ("Request Private Demo" →
  `/contact`) already point at the tenant-scoped `/about`/`/contact` — so today, on the
  true apex host, clicking any of them 404s (no tenant to resolve). `MarketingFooter`'s
  "Company" column and `SOCIAL_LINKS` have the same problem. This plan fixes all of it
  as part of adding the new links, per the developer's explicit "yes, fix it" decision
  (2026-09-05) — this is not scope creep, it's the same broken-link class this plan
  already has to touch.

## Pass 1 — Workflow Analysis

**Who uses it:** any public visitor, on any host (apex or a tenant subdomain) — the
header/footer render identically everywhere, the same way they do today.

**Workflow:** a visitor on the homepage (or anywhere the marketing chrome renders)
clicks "Download", "Support", "Pricing", "About", or "Contact" in the nav or footer and
lands on real content — not a 404, and not another tenant's own cafe page.

**Failure cases:**
- A stale link 404ing — this plan's entire point is eliminating that class of bug for
  five links that are broken today (`About`, `Support`'s `/contact` target, the CTA,
  the footer's `About IZUR`/`Contact`, and `SOCIAL_LINKS`' `About Chrono`).
- No tenant-isolation, RLS, or schema impact whatsoever — pure routing/composition.

**Audit / notifications:** none — no mutation anywhere in this plan.

## Pass 2 — Technical Planning

**Where it lives:** `apps/chrono-web` only, no `apps/chrono-api` change, no schema
change. `pnpm --filter @agora/api rls:proof` does not apply — nothing here touches
tenancy, RLS, or `APP_TENANT_TABLES`.

**New route group:** `apps/chrono-web/src/app/(apex-marketing)/` — a Next.js route
group (invisible in the URL, purely organizational, same mechanism the existing
`page-route-groups` plan already used for `(saas-landing)` etc.). Its `layout.tsx`
mirrors `(saas-landing)/page.tsx`'s own composition exactly (confirmed by reading it):

```tsx
import { PageShell, Main, MarketingHeader, MarketingFooter } from "@/components/landing/marketing-chrome"; // adjust import path to match actual export site
import type { ReactNode } from "react";

export default function ApexMarketingLayout({ children }: { children: ReactNode }) {
  const currentYear = new Date().getFullYear();
  return (
    <PageShell data-density="comfortable">
      <MarketingHeader />
      <Main>{children}</Main>
      <MarketingFooter year={currentYear} />
    </PageShell>
  );
}
```

(Confirm the real import path for `PageShell`/`Main` — they come from `agora/ui` in
`(saas-landing)/page.tsx`'s own imports, not from `marketing-chrome.tsx`; `MarketingHeader`/
`MarketingFooter` come from `@/components/landing/marketing-chrome`. Task 1 below is to
verify both import sites exactly before writing the file.)

Every sibling page plan (`download`, `support`, `pricing`, `terms`, `privacy`,
`company/about`, `company/contact`) then only writes its own `page.tsx` under this
group — no header/footer/PageShell of its own.

**`marketing-chrome.tsx` changes** (this is the ONLY plan that touches this file):

1. `NAV` (around line 51-57) — from:
   ```ts
   const NAV = [
     { label: "Features", href: "/#features" },
     { label: "Pricing", href: "/#pricing" },
     { label: "About", href: "/about" },
     { label: "Support", href: "/contact" },
     { label: "Login", href: "/login" },
   ];
   ```
   to:
   ```ts
   const NAV = [
     { label: "Features", href: "/#features" },
     { label: "Pricing", href: "/pricing" },
     { label: "About", href: "/company/about" },
     { label: "Support", href: "/support" },
     { label: "Download", href: "/download" },
     { label: "Login", href: "/login" },
   ];
   ```
   (Pricing moves from the homepage anchor to the new standalone route — the
   `apex-pricing-page` plan is what actually builds `/pricing`; this plan only
   repoints the link. If that plan hasn't landed yet when this one ships, coordinate
   ordering with the developer rather than shipping a temporarily-broken nav link —
   see Open Questions.)

2. The `MarketingHeader`'s CTA (`href="/contact"`, "Request Private Demo" / "Book
   demo", around line 89-96) → `/company/contact`.

3. `FOOTER_COLUMNS` (around line 223-242) — "Platform" column gains "Download"
   (`/download`) and "Support" (`/support`); "Company" column's `About IZUR` →
   `/company/about`, `Contact` → `/company/contact` (its `Privacy Policy`/`Terms of
   Service` entries already point at `/privacy`/`/terms` today even though neither
   route exists yet — those are latent-broken links the `apex-legal-pages` plan
   resolves; no change needed to those two hrefs in this plan).

4. `SOCIAL_LINKS` (around line 249-253) — `{ href: "/about", label: "About Chrono",
   Icon: Globe }` → `/company/about`.

5. Do **not** touch `TENANT_NAV`, `TenantFooter`, or any tenant-branded variant in this
   file — those correctly still point at a tenant's own `/about`, `/login`, etc.

## Explicitly out of scope

- The actual content of `/download`, `/support`, `/pricing`, `/terms`, `/privacy`,
  `/company/about`, `/company/contact` — each is its own sibling plan. This plan only
  builds the shared shell and repoints existing links.
- Any change to `(saas-landing)/about` or `/contact` (the real tenant features) or their
  backing registry/routes.
- Any change to `apps/chrono-api` — no schema, no route, no permission.

## Phase 1 — Route group + nav/footer fix

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/layout.tsx`.
- Edit: `apps/chrono-web/src/components/landing/marketing-chrome.tsx` (`NAV`, the
  header CTA, `FOOTER_COLUMNS`, `SOCIAL_LINKS` — exactly the five edits above).

**Step-by-step tasks:**
1. Read `(saas-landing)/page.tsx`'s import lines for `PageShell`/`Main` (from
   `agora/ui`) and confirm `MarketingHeader`/`MarketingFooter`'s real export site
   (`@/components/landing/marketing-chrome`) before writing `layout.tsx` — the sketch
   above must match exactly, not be re-guessed.
2. Write `(apex-marketing)/layout.tsx` per the composition above.
3. Apply the five `marketing-chrome.tsx` edits listed under Pass 2.
4. Add a placeholder route (e.g. temporarily reuse `(saas-landing)/page.tsx`'s content
   or a trivial "Coming soon" stub) is **not** needed — the sibling plans land their
   own `page.tsx` files under the new group; this phase does not need to pre-create
   empty pages for `/download` etc.

**Acceptance criteria:**
- `apps/chrono-web/src/app/(apex-marketing)/layout.tsx` exists and composes
  `PageShell`/`MarketingHeader`/`Main`/`MarketingFooter` identically to the homepage's
  own composition.
- Every nav/footer/CTA/social link in `marketing-chrome.tsx`'s apex-facing exports
  (`NAV`, `MarketingHeader`, `MarketingFooter`, `SOCIAL_LINKS`) resolves to a path that
  either already exists or is one of the sibling plans' declared new routes — no link
  points at `/about` or `/contact` (the tenant-scoped routes) from the apex chrome.
- `TENANT_NAV`/`TenantFooter` are unchanged (verify with a diff — this phase's diff
  should touch only `NAV`, the CTA `href`, `FOOTER_COLUMNS`, `SOCIAL_LINKS`).
- No new DB table, no `/rpc` route, no permission resource.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web build` (route-group layouts are a common source of
  a build-time "duplicate route" error if a path collision was missed — confirm the
  build succeeds with zero duplicate-route warnings).
- No `rls:proof` run required — no schema/tenancy/RLS touched.

**Out-of-scope (phase-level):** the sibling pages' own content — this phase does not
create `page.tsx` for `/download`, `/support`, `/pricing`, `/terms`, `/privacy`,
`/company/about`, or `/company/contact`.

**Execution start point:** Task 1 (confirm the exact import sites) — it's the only
task with any ambiguity; the rest is a mechanical edit once that's confirmed.

## Open Questions (developer to confirm/override)

1. **Landing order**: this plan's `NAV` edit repoints `Pricing` to `/pricing` and adds
   `Download` to `/download` — both routes come from sibling plans that haven't landed
   yet. Should this plan's Phase 1 land *after* at least one sibling page exists (so the
   nav never briefly points at a real 404), or is a short-lived 404 during a multi-plan
   rollout acceptable given these are separate, developer-sequenced implementation
   passes? Default assumption: acceptable, since each plan is reviewed/implemented
   independently and the developer controls ordering.
2. Confirm `PageShell`'s exact import path (`agora/ui` vs. a local re-export) before
   implementation — stated as an assumption above, not verified against the file at
   plan-writing time beyond the grep already done.

## After Implementation

Not yet — this plan is accepted and in `ready/`. Claiming `Implementation:` + committing
Phase 1 is the move to `in-progress/`, per `.ai/rules/feature-planning.md`.
