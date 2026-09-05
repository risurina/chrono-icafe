# Chrono — `apex-legal-pages` (Terms of Service / Privacy Policy)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Depends on:** `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first —
that plan creates the `(apex-marketing)` route group + shared layout
(`MarketingHeader`/`MarketingFooter`, no tenant gating) these two pages render inside.
Note: `apps/chrono-web/src/components/landing/marketing-chrome.tsx`'s
`FOOTER_COLUMNS` ("Company" column) already links to `/terms` and `/privacy` today even
though neither route exists yet — this plan is what makes those existing footer links
actually resolve instead of 404ing.

**Status:** Draft (not yet accepted — do not implement).

---

## Pass 1 — Workflow Analysis

**Who uses it:** any public visitor, on any host (apex or a tenant subdomain — these
pages render identically everywhere, same as the other `apex-marketing` pages),
checking Chrono/IZUR's Terms of Service or Privacy Policy — typically reached from the
footer link on any marketing or tenant-branded page.

**Workflow:** visitor clicks "Terms of Service" or "Privacy Policy" in the footer →
lands on a static page of section-by-section legal copy → reads. No account, no tenant
context, no session, no interaction of any kind.

**Failure cases:** none to speak of — this is static, read-only content with no form,
no data fetch, and no branching logic. Stated explicitly rather than inventing failure
modes that don't apply here.

**Audit / notifications:** none. Nothing mutates.

---

## Pass 2 — Technical Planning

**Where it lives:** `apps/chrono-web` only, two new files:
- `apps/chrono-web/src/app/(apex-marketing)/terms/page.tsx`
- `apps/chrono-web/src/app/(apex-marketing)/privacy/page.tsx`

Both are plain static Server Components — no fetch, no client component, no state.
Content only: the group's `layout.tsx` (from `apex-marketing-shell`) already supplies
`MarketingHeader`/`MarketingFooter`, so neither file renders its own header/footer.

**No new DB table, no `APP_TENANT_TABLES` entry, no RLS impact, no `/rpc` route, no
permission gate.** This phase touches no schema/tenancy, so `rls:proof` does not apply —
stated explicitly per `AGENTS.md`'s "Before you finish" gate, so it isn't mistaken for
an oversight.

**Reference content (read during this planning pass, for structure/copy reference
only):** `~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/terms/page.tsx` and
`.../privacy/page.tsx`. Both are short — four labeled sections each (a heading + one
paragraph per section), not dense legal boilerplate:
- **Terms**: "Use of service", "Account responsibility", "Operational data", "Changes
  and support".
- **Privacy**: "Information we collect", "How we use information", "Data protection",
  "Contact".

Both also carry a "Last updated" date line under the page title.

**Component composition:** `agora/ui` has no dedicated long-form "prose" primitive
(confirmed by checking `packages/agora/src/presentation/ui/index.ts`'s exports — the
oikos reference's `Container`/`Section`/`Text`/`Heading` come from its own sibling
package, `@risurina/oikos/ui`, not from `agora/ui`). No new primitive is needed for two
short, static pages: compose from `agora/ui`'s existing `Section`, `Container`, `Stack`
for layout, and plain semantic heading/paragraph tags (`<h1>`, `<h2>`, `<p>`) styled
with Tailwind + semantic tokens for the text itself — the same pattern already used
directly in this app's own `marketing-chrome.tsx` and `tenant-sections.tsx` (which both
write raw `<h1>`/`<p>`/`<span>` with `cn()` + semantic classes; `.ai/rules/
component-first-ui.md`'s raw-element prohibition names `div`/`label`/`input`/`button`/
`select`/`textarea` specifically, not heading/paragraph text tags). No hardcoded hex
colors — semantic tokens only.

**Why one phase covers both files:** the two pages are trivially identical in shape
(static legal prose, zero logic, zero interactivity) — splitting them into two phases
would be needless process overhead for content that ships and verifies together.

---

## Explicitly out of scope

- **Any tenant-specific Terms/Privacy variation.** This is IZUR's own platform-wide
  legal content, not a tenant-configurable landing section — out of scope for
  `.ai/rules/json-render.md`'s tenant-configurable-content allowance.
- **A cookie-consent banner or other compliance tooling.** This plan is the two content
  pages only, not a broader compliance/consent feature.
- **Legally reviewing or drafting new legal language.** See the open question below —
  this plan carries the reference copy forward, it does not originate new legal terms.

---

## Phase 1 — Terms of Service + Privacy Policy pages

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/terms/page.tsx` — static Server
  Component. A hero block (eyebrow "Terms of Service", `<h1>` "Terms for using
  Chrono.", a "Last updated" line) followed by the four sections above, each a heading
  + paragraph, laid out with `Section`/`Container`/`Stack` and a `max-w-3xl` reading
  column (mirroring the reference's centered single-column layout).
- New: `apps/chrono-web/src/app/(apex-marketing)/privacy/page.tsx` — same shape, the
  four Privacy sections above.
- Both files set `export const metadata` (Next.js `Metadata`) with a page title/
  description, mirroring the reference (`"Terms of Service — Chrono"` /
  `"Privacy Policy — Chrono"`).

**Step-by-step tasks:**
1. Write `apps/chrono-web/src/app/(apex-marketing)/terms/page.tsx`: hero + a typed
   local `const sections = [...]` array (title/body pairs, content per the open
   question below) mapped into `Section`/heading/paragraph markup, no raw `div`/
   `button`/`input` chrome.
2. Write `apps/chrono-web/src/app/(apex-marketing)/privacy/page.tsx`, same structure,
   Privacy content.
3. Confirm both render correctly nested inside the `apex-marketing-shell` layout (no
   duplicate header/footer, no layout shift).

**Acceptance criteria:**
- Visiting `/terms` and `/privacy` on any host renders the full section content with
  no 404 — this is also what makes the existing `FOOTER_COLUMNS` links (which already
  point at these two paths today) resolve correctly for the first time.
- Every visible element is built from `agora/ui` primitives or plain semantic text
  tags with semantic Tailwind tokens — no raw `div`/`button`/`input`/`select`/
  `textarea`, no hardcoded hex colors, per `.ai/rules/component-first-ui.md` and
  `.ai/rules/styling.md`.
- No new DB table, no `APP_TENANT_TABLES` entry, no new permission resource, no `/rpc`
  route added.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web dev`, then manually load `/terms` and `/privacy` on
  `APP_DOMAIN:3000` and confirm the footer links from any other apex-marketing page now
  resolve instead of 404ing.
- No `rls:proof` run required — this phase touches no schema/tenancy/RLS.

**Out of scope (phase-level, restates plan-level section above):** tenant-specific
legal variants, a cookie-consent banner, and originating new legal language beyond what
the open question below resolves.

**Execution start point:** resolve the open question below (carry reference copy
forward vs. developer/legal-supplied copy) with the developer first, then start at
Task 1 (`terms/page.tsx`) — it has no dependency on Task 2 and can be built and
manually verified before starting the Privacy page.

---

## Open Questions (developer to confirm/override)

1. **Legal copy source.** This repo's "improve, don't port oikos" rule governs design/
   code, not legal wording. The reference content is short and generic (four
   section headings + one paragraph each, not a dense lawyer-drafted document) —
   should this plan carry that reference copy forward close to verbatim (updating only
   the "Last updated" date), or does the developer want to supply final Terms/Privacy
   text (or route this through actual legal review) before Phase 1 implements it? This
   plan's Phase 1 assumes "carry the reference copy forward" as the default *unless*
   the developer says otherwise before implementation starts.
2. Should these two pages eventually surface anywhere else (e.g. a required checkbox
   at tenant sign-up, "I agree to the Terms")? Not addressed by this plan — flagging
   only so it isn't silently assumed either way; today nothing links *to* acceptance,
   only *from* the footer.

---

## After Implementation

Not yet — this plan is in `draft/`. Per `.ai/rules/feature-planning.md`, it needs the
developer's explicit acceptance (and passes the Concreteness Gate above) before moving
to `ready/`, and claiming `Implementation:` + committing Phase 1 before moving to
`in-progress/`.
