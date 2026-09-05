# Chrono — `apex-company-about` (IZUR/Chrono company "About" page)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Depends on:** `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first —
that plan creates the `(apex-marketing)` route group + shared layout
(`MarketingHeader`/`MarketingFooter`, no tenant gating) this page's content sits inside,
and wires the nav/footer "About" link to `/company/about`.

**Status:** Accepted 2026-09-05, in `ready/`. Open question 1 (verbatim vs. updated
factual claims) stands as documented default unless overridden before/during
implementation.

---

## Pass 1 — Workflow Analysis

**Who uses it:** any public visitor, on any host (apex or a tenant subdomain — the
marketing chrome renders identically everywhere), who wants to learn about IZUR/Chrono
as a company before signing up or reaching out.

**Workflow:** visitor opens `/company/about` → reads the company's mission and a few
credibility points → optionally clicks through to `/company/contact` or `/sign-up`.
Read-only; no form, no submission, no account.

**Failure cases:** none to speak of — this is static content with no external
dependency, no database read, and no user input. Stated explicitly rather than
inventing a failure mode that doesn't exist.

**Audit / notifications:** none. Nothing mutates.

---

## Pass 2 — Technical Planning

**Where it lives:** `apps/chrono-web` only. No `apps/chrono-api` route, no new table,
no contract:

- **No new tenant table, no `APP_TENANT_TABLES` entry, no RLS impact.** This phase
  makes zero schema change — `rls:proof` does not apply, stated explicitly so it isn't
  mistaken for an oversight.
- **No `/rpc` route, no permission gate.** The content is public, identical on every
  host, and fixed (IZUR's own copy, not a tenant's) — a single static Server Component
  is the whole surface.

**Where it renders:** `apps/chrono-web/src/app/(apex-marketing)/company/about/page.tsx`.
This is a **new, distinct path** from the existing
`apps/chrono-web/src/app/(saas-landing)/about/page.tsx`, which is a different, already-
built feature: that file renders a specific **tenant's own** landing "About" section
(registry-driven, via `getTenantLanding()`, 404s without a tenant) — do not touch it,
do not reuse its route. This plan's page is IZUR-the-company's own about page and is
apex-only in content (though, like the rest of `(apex-marketing)`, it renders on any
host, not gated to the apex specifically).

**Design reference (layout/UX/copy inspiration only — not ported):**
`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/about/page.tsx` — a hero
(eyebrow "About IZUR", headline, one paragraph of company copy, a "Talk to IZUR" CTA
button), a pulled-quote "mission" block, and a 2×2 grid of four credibility cards
(PH-based team / Real operations focus / Implementation support / Built for growth,
each with an icon + title + one-line description). Rebuilt fresh from `agora/ui`
primitives and semantic tokens, not ported — its raw `div` chrome and hardcoded
`gold`/`zinc-900` literals are exactly what `.ai/rules/component-first-ui.md` and
`.ai/rules/styling.md` prohibit here.

---

## Explicitly out of scope (and why)

- **Any dynamic/CMS-editable version of this content.** This is IZUR's own fixed
  marketing copy, not tenant-configurable content — `.ai/rules/json-render.md`'s
  allowed uses (tenant-configurable sections, CMS-like blocks) don't apply; a plain
  React Server Component is the correct shape.
- **The tenant's own `/about` page.** Unrelated, already built (registry-driven
  landing sections) — this plan does not touch
  `apps/chrono-web/src/app/(saas-landing)/about/page.tsx` or
  `apps/chrono-web/src/components/landing/tenant-sections.tsx`.
- **Editing `marketing-chrome.tsx`'s nav/footer.** Owned by the `apex-marketing-shell`
  plan (it repoints the existing "About" nav/footer/social entries at
  `/company/about`) — this plan only builds the page content those links resolve to.

---

## Phase 1 — Company "About" page

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/company/about/page.tsx` — a static
  Server Component (no `async`, no data fetching needed). Content only — no
  header/footer, no `PageShell` (the group `layout.tsx` from `apex-marketing-shell`
  supplies those). Composed entirely from `agora/ui`:
  - A hero `Section`: eyebrow text ("About IZUR"), an `h1` headline, one paragraph of
    body copy (`Text`), and a primary `Button`/`Link` to `/company/contact` ("Talk to
    IZUR").
  - A pulled-quote mission block: the mission statement rendered in a `Card` or a
    styled `blockquote`-equivalent using `agora/ui` primitives (no raw `<blockquote>`
    with hand-rolled border/italic classes — use `Text` with a semantic emphasis
    treatment already available in the design system, or a `Card` with a quote icon).
  - A `Grid` of four `Card`s (credibility points), each with an icon (`lucide-react`,
    already a workspace dependency), a `CardTitle`, and a `CardDescription` — mirror
    `StatTile`'s existing icon+label+description shape from
    `packages/agora/src/presentation/ui/components/custom/stat-tile.tsx` if it fits, or
    plain `Card`/`CardHeader`/`CardContent` otherwise.
- Add `export const metadata: Metadata` with a title ("About IZUR — Chrono") and
  description, mirroring the reference's `generateMetadata`/`metadata` pattern already
  used in `(saas-landing)/about/page.tsx`.

**Step-by-step tasks:**
1. Write the static copy: mission statement, one intro paragraph, and the four
   credibility cards (title + one-line description each) — adapt the reference's
   actual wording to Chrono/agora's voice (it currently says "IZUR IT Solutions
   builds practical software..." — keep the substance, rewrite so it isn't a verbatim
   copy-paste, since this is marketing copy the developer may want to tune).
2. Build the hero section (`Section` + eyebrow + heading + body + CTA `Button`)
   composed only from `agora/ui` primitives, semantic tokens (`text-muted-foreground`,
   `bg-primary`, etc.) — no hardcoded hex/`gold`/`zinc-*` classes.
3. Build the mission pulled-quote block.
4. Build the four-card credibility grid using `Grid`/`Card` from `agora/ui`.
5. Add `metadata` export for the page `<title>`/description.

**Acceptance criteria:**
- Visiting `/company/about` on any host (apex or a tenant subdomain) renders the same
  static content — no 404, no tenant dependency.
- Every visible affordance is built from `agora/ui` primitives (`Section`, `Card`,
  `Grid`, `Button`, `Text`) — no raw `div`/`span`/`blockquote` chrome, per
  `.ai/rules/component-first-ui.md`. No hardcoded color literals — semantic tokens
  only, per `.ai/rules/styling.md`.
- Header/footer come from the group `layout.tsx`, not this page.
- No new DB table, no `/rpc` route, no new permission resource.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web dev`, then manually load `/company/about` on
  `APP_DOMAIN:3000` and on a tenant subdomain, confirming identical content on both.
- No `rls:proof` run required — this phase touches no schema/tenancy/RLS.

**Out of scope (phase-level, restates plan-level section above):** any CMS/tenant-
configurable variant of this content; the tenant's own `/about`; nav/footer wiring
(owned by `apex-marketing-shell`).

**Execution start point:** start at Task 1 (finalize the static copy) — everything
else is straightforward composition once the copy is settled; no external dependency
or ordering constraint with any other phase in this plan.

---

## Open Questions (developer to confirm/override)

1. The reference's copy ("PH-based team," "City of SJDM, Bulacan" references
   elsewhere on the site) is specific to IZUR's actual business details — confirm
   whether to keep these facts verbatim (they're real company facts, not just
   design/UX to "improve on") or whether the developer wants different/updated
   copy for this rebuild.
2. Should this page link out anywhere else (e.g. `/pricing`, `/download`) beyond the
   `/company/contact` CTA? Not included above since it wasn't asked for — a one-line
   addition if wanted later.

---

## After Implementation

Not yet — this plan is accepted and in `ready/`. Claiming `Implementation:` + committing
Phase 1 is the move to `in-progress/`, per `.ai/rules/feature-planning.md`.
