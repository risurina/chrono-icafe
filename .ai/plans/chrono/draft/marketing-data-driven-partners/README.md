# Chrono marketing page: data-driven partners section

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]

## Context / why

The developer asked for a new section on Chrono's apex marketing page
(`apps/chrono-web/src/app/(saas-landing)/page.tsx`) — a "data-driven partners"
proof section, placed **before** the existing "Operational reality" section
(the `eyebrow="Operational reality"` block at line 470-491, the first content
section after the hero, which lists problems with legacy tools).

Confirmed with the developer:
- **Content mix:** a logo cloud (partner/customer category chips) *plus* a row
  of stat tiles — not one or the other.
- **Content source:** Chrono has no real customers yet (still Wave 1 of the
  migration per `apps/chrono-api/AGENTS.md`'s "Status" section), so every logo
  and number in this section must be **illustrative, not fabricated claims
  about real usage** — generic venue-category labels (no invented company
  names) and round, defensible numbers framed as designed **capacity/targets**
  ("branches supported per account", "uptime target"), never as claimed
  current traction ("trusted by 500 venues already live"). The one exception:
  the existing, already-true architectural fact from the page's own
  Comparison section ("Per-tenant row-level security enforced at the
  database") can be reused verbatim as a real stat, not an illustrative one.

This is a pure marketing-copy/presentation change to a **static, non-tenant,
non-configurable** page (the file's own comment at line 748 draws this exact
line: "Tenant host → the registry-driven public landing page" is a *separate*
branch of this same file, driven by `packages/agora`'s landing-section
registry — this plan does not touch that branch or that registry at all). No
schema, API, RLS, tenant-scoping, or permission-gate surface is touched.

## Pass 1 — Workflow analysis

- **Who uses this:** an unauthenticated visitor to the Chrono apex marketing
  page (`http://localhost:3000/` in dev, apex `APP_DOMAIN` in prod) — the same
  audience as every other section on this page. No tenant, no session.
- **Workflow enabled:** purely informational/persuasive — builds credibility
  ("this product is built for real operational scale, across various venue
  types") right after the hero's product pitch and right before the page
  pivots to "here's what's wrong with the old way." No click/form/API call is
  added.
- **Failure cases:** none of the usual tenant/auth/RLS failure modes apply —
  this is static JSX with no data fetch of its own. The only real "failure
  case" is a copy/design one: the section must not misstate Chrono's actual
  traction (see "Content source" above) and must not break the page's layout
  on mobile (badge row wrapping, stat grid collapsing to fewer columns).
- **Audit/notifications:** none — no mutation, no user-controlled state.

## Pass 2 — Technical plan

- **Boundary:** `apps/chrono-web` only. Nothing in `packages/agora` or
  `apps/chrono-api` changes.
- **Nearest existing pattern:** every other section on this same page —
  `apps/chrono-web/src/app/(saas-landing)/page.tsx`'s apex branch (lines
  93–746) is one file, each section a plain local `const` data array rendered
  inside a `<Section>` built from `agora/ui` primitives
  (`Section`/`Grid`/`Stack`/`Row`/`Card`/`SectionHeading`/`Badge`). The new
  section follows this exact shape — no new component file, no new registry
  entry (that machinery is for the tenant-configurable branch, out of scope
  here per Context above).
- **Stat tiles:** reuse `StatTile` (`agora/ui`,
  `packages/agora/src/presentation/ui/components/custom/stat-tile.tsx`) — already
  used in this same page's hero mockup card (line 411-418), so this is a
  direct visual echo of an already-established pattern, not a new primitive.
- **"Logo" chips:** no logo image assets exist for a pre-launch product
  (confirmed illustrative-only). Compose `Badge` (variant="outline") with a
  leading `lucide-react` icon + a generic category label — text/icon chips,
  not raster logos. Needs 3-4 new icon imports from the already-installed
  `lucide-react` (no new dependency).
- **Section chrome/tone:** insert the new `<Section>` between the existing
  hero `<Section>` (closes line 468) and the "Operational reality" `<Section>`
  (opens line 470), using `border="bottom"` with no `tone` override (matching
  the hero and "Operational reality" sections' own plain/no-tone styling) —
  this means every later section's existing `tone="muted"`/plain alternation
  is untouched, so this is a pure insertion with zero edits to any other
  section's props.
- **Contracts/DTO/RBAC/RLS/pagination:** not applicable — no data layer
  touched.
- **E2E:** not mandatory. `.ai/rules/e2e-testing.md`'s mandatory-e2e gate is
  scoped to **tenant-scoped** features (new tenant table/route/dashboard
  flow); this is static apex marketing copy with no tenant context, no
  precedent for e2e coverage on this page today (confirmed: neither
  `apps/chrono-web/e2e/tests/` nor `apps/agora-web/e2e/tests/` has a
  landing/marketing spec — only `tenant-landing/` specs exist, which cover the
  *tenant-configurable* page, a different code path). Verification is manual
  `pnpm dev`, consistent with how this same app's own
  `.ai/plans/chrono/archive/auth-page-header-footer/README.md` verified its
  non-security-critical chrome phases.

## Phase 1 — Add the "data-driven partners" section

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx`

**Step-by-step tasks:**
1. Add new `lucide-react` icon imports to the existing import block (top of
   file): `Gamepad2`, `Building2`, `Coffee` (alongside already-imported
   `Users`, `Briefcase`-style icons — reuse `Users` if it reads better than
   importing yet another icon for one category).
2. Add two new local `const`s inside `Home()`, right before the `return (` of
   the apex branch (near the other data arrays like `problems`, `highlights`):
   - `trustCategories`: 4-5 `{ icon, label }` entries — generic venue
     categories Chrono targets, e.g. Gaming Lounges, Esports Arenas,
     Co-working Spaces, Study Cafés, Franchise Groups. No real company names.
   - `trustStats`: 4 `{ label, value }` entries — illustrative
     capacity/target numbers plus the one real architectural fact, e.g.:
     - `{ label: "Branches supported per account", value: "50+" }`
     - `{ label: "Sessions trackable per month", value: "10,000+" }`
     - `{ label: "Uptime target", value: "99.9%" }`
     - `{ label: "Tenant data isolation", value: "Row-level, enforced at the DB" }`
     (exact wording is copy polish, not an open decision — keep the "target/
     supported/trackable" framing, never "already running" / "trusted by"
     phrasing that implies live customers.)
3. Insert a new `<Section maxWidth="full" border="bottom">` immediately after
   the hero section's closing `</Section>` (currently line 468) and before the
   "Operational reality" `<Section>` (currently line 470):
   - `<SectionHeading eyebrow="By design" title="Built for every kind of floor — and the scale to back it up." className="mb-10 max-w-prose" align="center" />` (centered, matching the "Why it's built this way" section's centered-heading precedent).
   - A `<Row wrap items="center" justify="center" gap={3}>` of `trustCategories`,
     each rendered as `<Badge variant="outline" className="gap-2 py-2 px-3 text-sm font-normal text-muted-foreground"><Icon className="h-4 w-4" aria-hidden />{label}</Badge>`.
   - Below it, a `<Grid cols={4} gap={4} className="mt-10">` of `trustStats`
     rendered via `<StatTile key={label} label={label} value={value} />`
     (identical usage to the hero card's stat tiles).
4. Do not modify any other section's props, order, or copy.

**Acceptance criteria:**
- On `http://localhost:3000/` (apex, no tenant host), the new section renders
  between the hero and "Operational reality", with the category badge row
  above the 4-stat grid.
- No fabricated specific company/partner names appear anywhere in the new
  copy; stat wording reads as capacity/target, not claimed live usage.
- Badge row wraps cleanly on mobile widths (justify-center + wrap already
  handles this, matching the hero's own `<HeroChips>`/`<Row wrap>` usage).
- Stat grid collapses gracefully below `lg` per `Grid`'s existing responsive
  behavior (same component already used elsewhere on this page at `cols={4}`).
- Section respects light and dark theme via existing semantic tokens only (no
  new hardcoded color classes) — spot-check both via the app's theme toggle.
- `pnpm --filter @agora/chrono-web typecheck` passes with zero new errors.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: `pnpm --filter @agora/chrono-api dev` (in one terminal) +
  `pnpm --filter @agora/chrono-web dev` (in another), then visit
  `http://localhost:3000/` and check the acceptance criteria above, including
  a manual resize to a mobile viewport and a manual light/dark toggle.

**Out of scope:**
- The tenant-configurable landing page / `CHRONO_LANDING_SECTIONS` registry
  (`apps/chrono-web/src/components/landing/registry.ts`) — untouched.
- Any real partner logo assets, real customer names, or real usage metrics —
  explicitly deferred until Chrono has real customers to report on.
- Any change to `packages/agora` (no new `agora/ui` primitive needed — `Badge`
  and `StatTile` already cover this section's needs).
- Automated e2e coverage for this page (see Pass 2 — not mandatory, no
  existing precedent on this specific page).
- Re-flowing/re-toning any other section on the page.

**Execution start point:**
`apps/chrono-web/src/app/(saas-landing)/page.tsx` — read lines 1-64 (imports)
and lines 329-470 (hero + start of "Operational reality") before editing.

## Out of scope (whole plan)

- Everything listed under Phase 1's "Out of scope" above — this is a
  single-phase plan; there is no Phase 2.
- Copywriting beyond the illustrative categories/stats named above — final
  wording polish happens during implementation, not as a separate planning
  pass, since it carries no architectural weight.

## Verification (overall)

- `pnpm --filter @agora/chrono-web typecheck` passes.
- Manual `pnpm dev` check per Phase 1's acceptance criteria (apex host, both
  themes, mobile width).

## Plan Closure

Move to `.ai/plans/chrono/archive/marketing-data-driven-partners/` once Phase
1's acceptance criteria and verification commands pass.
