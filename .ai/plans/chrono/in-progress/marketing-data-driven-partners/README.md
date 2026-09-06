# Chrono marketing page: data-driven partners section

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit: plan-auditor subagent (aca5d004d6c00a00e), via /feature pipeline — APPROVED WITH CONDITIONS, all conditions folded in below
- Implementation: agora-19 [75ff11]

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
non-configurable** page (the file's own comment at line 746 draws this exact
line: "Tenant host → the registry-driven public landing page" is a *separate*
branch of this same file, driven by `packages/agora`'s landing-section
registry — this plan does not touch that branch or that registry at all). No
schema, API, RLS, tenant-scoping, or permission-gate surface is touched.

**Audit note (folded in below):** the `plan-auditor` agent reviewed this plan
against the live source and returned APPROVED WITH CONDITIONS — no blockers,
six conditions (a missing vertical-padding wrapper, a stat that contradicted
this same page's own "Unlimited branches" claim, a centering bug, an
oversized sentence inside a numeric `StatTile`, a wrong responsive
breakpoint, and a mis-cited e2e precedent) and two risks (two of the four
stats were unbacked marketing numbers — a never-published uptime figure and
an implied usage meter that doesn't exist). The developer's calls on the two
risks (drop both) and the fixes for all six conditions are folded into Pass 2
and Phase 1 below — this is the plan as it will be built, not the
pre-audit draft.

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
- **E2E:** not mandatory — `.ai/rules/e2e-testing.md`'s mandatory-e2e gate is
  scoped to **tenant-scoped** features (new tenant table/route/dashboard
  flow), and this is static apex marketing copy with no tenant context, no
  data path, and no interactive surface. Confirmed: neither
  `apps/chrono-web/e2e/tests/` nor `apps/agora-web/e2e/tests/` has a
  landing/marketing spec today — only `tenant-landing/` specs exist, covering
  the *tenant-configurable* page, a different code path.
  (Audit correction: an earlier draft of this section cited
  `.ai/plans/chrono/archive/auth-page-header-footer/README.md` as manual-only
  precedent — that plan's Phase 5 actually **does** ship a dedicated spec,
  `apps/chrono-web/e2e/tests/auth/header-footer.spec.ts`, for the same class
  of non-tenant presentation chrome. Corrected precedent, followed: add one
  light smoke spec rather than manual-only.) Add
  `apps/chrono-web/e2e/tests/marketing/data-driven-partners.spec.ts`, run the
  same way as `header-footer.spec.ts` (headed, `slowMo`, no `webServer` —
  needs `pnpm dev` already running), asserting on `/`: the new section's
  heading text is visible, all 4 category badges render, and all 4 stat
  tiles render with non-empty values. This is a single small `.spec.ts`, not
  a new phase.

## Phase 1 — Add the "data-driven partners" section

**Files to update:**
- `apps/chrono-web/src/app/(saas-landing)/page.tsx`
- `apps/chrono-web/e2e/tests/marketing/data-driven-partners.spec.ts` (new)

**Step-by-step tasks:**
1. Add new `lucide-react` icon imports to the existing import block (top of
   file): `Gamepad2`, `Building2`, `Coffee` (reuse the already-imported
   `Users` for the fourth category — `Briefcase` is not imported anywhere in
   this file today, so don't introduce it just for this section).
2. Add two new local `const`s inside `Home()`, right before the `return (` of
   the apex branch (near the other data arrays like `problems`, `highlights`):
   - `trustCategories`: 4 `{ icon, label }` entries — generic venue
     categories Chrono targets, no real company names:
     - `{ icon: Gamepad2, label: "Gaming Lounges" }`
     - `{ icon: Building2, label: "Co-working Spaces" }`
     - `{ icon: Coffee, label: "Study Cafés" }`
     - `{ icon: Users, label: "Franchise Groups" }`
   - `trustStats`: 4 `{ label, value }` entries. Audit finding (CONDITION 2):
     the original draft's "Branches supported per account: 50+" directly
     contradicts this same page's own Comparison-table claim at
     `page.tsx:194` ("Unlimited branches under one business, one login") —
     reworded to match it instead of contradicting it. Audit finding
     (RISKs 1–2, developer decision): the original draft's "Uptime target:
     99.9%" (no SLA/status page backs this — would be Chrono's first-ever
     published availability figure) and "Sessions trackable per month:
     10,000+" (implies a usage meter/quota that exists in no pricing tier)
     are both **dropped** per the developer's explicit call, replaced with
     two more architectural facts in the same spirit as the RLS stat — real,
     verifiable in code today, not projections:
     - `{ label: "Branches per account", value: "Unlimited" }` — matches
       `page.tsx:194` verbatim in substance.
     - `{ label: "Built-in modules", value: "20+" }` — real count:
       `apps/chrono-api/src/modules/` has 24 module folders today
       (wallet, POS, loyalty, reservations, vouchers, promos, shifts,
       devices, realtime, …); "20+" is a conservative, defensible round-down,
       not a specific claim that could go stale on the next module addition.
     - `{ label: "Realtime sync", value: "Built-in" }` — real feature:
       `agora/realtime` + `apps/chrono-web/src/lib/realtime.ts` wire a live
       WebSocket connection today; not illustrative.
     - `{ label: "Tenant data isolation", value: "Row-level" }` — the one
       real architectural fact from the Comparison section
       (`page.tsx:204`, "Per-tenant row-level security enforced at the
       database"), condensed to fit `StatTile`'s `text-2xl` value slot
       (audit finding, CONDITION 4: the original draft's full sentence as
       `value` renders 24px text wrapping 3-4 lines in a 160px-min-width
       tile, breaking row height alignment against the other three
       short values — condensing to "Row-level" preserves the fact
       verbatim in substance while fitting the primitive as every other
       stat on this page uses it).
3. Insert a new `<Section maxWidth="full" border="bottom">` immediately after
   the hero section's closing `</Section>` (currently line 468) and before the
   "Operational reality" `<Section>` (currently line 470), wrapping its
   content in `<div className="py-20">` exactly like every sibling section on
   this page (`page.tsx:471`, `:500`, `:527`, `:557`, `:642`, `:667` all do
   this — audit finding, CONDITION 1: `Section`/`Container` supply no
   vertical padding of their own, only horizontal, so without this wrapper
   the new band renders flush against both `border-b` rules):
   - `<SectionHeading eyebrow="By design" title="Built for every kind of floor — and the scale to back it up." align="center" className="mx-auto mb-10 max-w-prose" />`
     (audit finding, CONDITION 3: `className` must include `mx-auto`, not just
     `align="center"` — `SectionHeading` renders a `Stack`, which is a plain
     `space-y-*` div, not flex, so `align="center"`'s `items-center` is inert
     and only `mx-auto` actually centers the block; this matches the "Why
     it's built this way" section's own precedent at `page.tsx:648`,
     `className="mx-auto mb-12 max-w-prose items-center text-center"`).
   - A `<Row wrap items="center" justify="center" gap={3}>` of `trustCategories`,
     each rendered as `<Badge variant="outline" className="gap-2 py-2 px-3 text-sm font-normal text-muted-foreground"><Icon className="h-4 w-4" aria-hidden />{label}</Badge>`.
   - Below it, a `<Grid cols={2} gap={4} className="mt-10 lg:grid-cols-4">` of
     `trustStats` rendered via `<StatTile key={label} label={label} value={value} />`
     (audit finding, CONDITION 5: `Grid`'s `cols={4}` maps to
     `sm:grid-cols-4` — i.e. it jumps straight from 1 to 4 columns at 640px —
     while each `StatTile` card carries `min-w-[160px]`, so four tracks plus
     three `gap-4` need ~688px of inner width against the ~590-670px the
     container gives at 640-768px after its `px-6`/`px-8` padding: a likely
     horizontal overflow in exactly that band. `cols={2}` with an explicit
     `lg:grid-cols-4` override keeps it at 2 columns through that band and
     only goes to 4 columns at `lg` (1024px), where there's room).
4. Add `apps/chrono-web/e2e/tests/marketing/data-driven-partners.spec.ts`
   per Pass 2's E2E note above.
5. Do not modify any other section's props, order, or copy.

**Acceptance criteria:**
- On `http://localhost:3000/` (apex, no tenant host), the new section renders
  between the hero and "Operational reality", with the category badge row
  above the 4-stat grid.
- No fabricated specific company/partner names appear anywhere in the new
  copy; stat wording reads as capacity/target, not claimed live usage.
- Badge row wraps cleanly on mobile widths (justify-center + wrap already
  handles this, matching the hero's own `<HeroChips>`/`<Row wrap>` usage).
- Stat grid is single-column below `sm` (640px), 2 columns from `sm` to just
  under `lg`, and 4 columns from `lg` (1024px) up — per the corrected
  `cols={2} ... lg:grid-cols-4` above (audit correction, CONDITION 5: the
  original criterion said "below `lg`", which doesn't match `Grid`'s actual
  breakpoint map; the real risk band was 640-768px, now fixed, not just
  mis-described).
- No horizontal overflow/scroll on the badge row or stat grid at 640px and
  768px viewport widths specifically (the band CONDITION 5 identified as the
  actual risk) — check both, not just a generic "mobile" resize.
- Section respects light and dark theme via existing semantic tokens only (no
  new hardcoded color classes) — spot-check both via the app's theme toggle.
- `pnpm --filter @agora/chrono-web typecheck` passes with zero new errors.
- `apps/chrono-web/e2e/tests/marketing/data-driven-partners.spec.ts` passes:
  heading visible, 4 category badges rendered, 4 stat tiles rendered with
  non-empty values.

**Verification commands:**
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: `pnpm --filter @agora/chrono-api dev` (in one terminal) +
  `pnpm --filter @agora/chrono-web dev` (in another), then visit
  `http://localhost:3000/` and check the acceptance criteria above, including
  a manual resize to 640px/768px/mobile viewports and a manual light/dark
  toggle.
- `npx playwright test e2e/tests/marketing/data-driven-partners.spec.ts` (run
  from `apps/chrono-web`, dev servers already running per the manual step
  above — same invocation style as `header-footer.spec.ts`).

**Out of scope:**
- The tenant-configurable landing page / `CHRONO_LANDING_SECTIONS` registry
  (`apps/chrono-web/src/components/landing/registry.ts`) — untouched.
- Any real partner logo assets, real customer names, an uptime/SLA figure, or
  a usage-volume/meter claim — explicitly deferred until Chrono has real
  customers and real operational data to report on (audit RISKs 1-2,
  developer call: drop both rather than publish unbacked numbers).
- Any change to `packages/agora` (no new `agora/ui` primitive needed — `Badge`
  and `StatTile` already cover this section's needs).
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
  themes, 640px/768px/mobile widths).
- `apps/chrono-web/e2e/tests/marketing/data-driven-partners.spec.ts` passes.

## Plan Closure

Move to `.ai/plans/chrono/archive/marketing-data-driven-partners/` once Phase
1's acceptance criteria and verification commands pass.
