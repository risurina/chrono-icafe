# Chrono — SaaS apex landing page rebuild (v2, improved on oikos)

**Status:** Done — implemented and verified.

- Phase 1 (`SectionHeading` primitive) — complete, commit `9bc8a94`.
- Phase 2 (apex homepage rebuild) — complete, commit `b03c901`.
- Phase 3 (verify & commit) — `turbo run typecheck` passes workspace-wide (7/7);
  no `lint` script exists for `@agora/chrono-web` (pre-existing, not added by
  this plan); visual pass done via a Playwright script driving the dev server
  (desktop light/dark + mobile-width screenshots, no console/page errors).

## What this is

`apps/chrono-web/src/app/(saas-landing)/page.tsx`'s apex half (the `!tenant`
branch, currently lines ~78–598) is a placeholder-quality rebrand written by
the archived `.ai/plans/chrono/archive/chrono-landing/` plan, drafted *without*
the oikos reference (it wasn't available on this machine at the time). The
developer has now pointed at the real prior art —
`C:\Users\ronni\project\izur\oikos\apps\chrono-web` (live at
`https://chrono.izur.com.ph/`) — and asked for this page to become Chrono-web's
main landing, replicating that page's structure and components **but
improved**, per `apps/chrono-api/AGENTS.md`'s standing instruction that oikos
is prior art, not a spec.

This plan rebuilds only the **apex marketing homepage** (the `!tenant` branch
of `(saas-landing)/page.tsx`). Out of scope: the tenant-host half of the same
file (the branded mini-landing on `{slug}.CHRONO_DOMAIN}`, untouched since the
archived plan), and every other route under `(saas-landing)` (`/about`,
`/contact`, `/sign-up`, `/login`, …) — those already exist and aren't part of
"the main landing."

### Research summary (from reading the oikos source directly)

oikos's actual live homepage (`src/app/(landing)/page.tsx`, composed from
`components/platform/landing/sections/*.tsx`) renders, in order: Hero → Live
Command Center dashboard preview → brand trust strip → Problem → Solution →
Modules bento → Role segments → Comparison table → How it works → Owner
benefits/"design philosophy" → Surfaces/product showcase → Mobile app preview
→ Pricing teaser → FAQ → Final CTA. All of it runs on a forced-dark
"gold-on-black" visual identity (`#080806` background, `#D6A84F` gold accent)
with `framer-motion` installed but unused — every animation is plain Tailwind
`animate-pulse`/`transition-*` or a Radix accordion.

Two things in that repo are **not** real and must not be ported: a parallel
`components/platform/landing/saas/` folder (generic "Oikos" multi-tenant
boilerplate copy, never wired into any route) and a duplicate
`components/common/landing/` header/footer pair, also unwired. Both are dead
scaffold leftovers.

### Decisions pinned (from developer answers — do not re-litigate)

1. **Theme**: stay theme-aware. Keep the existing `agora/ui` semantic tokens
   (`primary`/`muted`/`accent`/`destructive`) and the `ThemeToggle` exactly as
   the current page already does. **No new color tokens, no forced-dark
   palette, no gold hex values.** "Highlighted" tiles use the existing
   `bg-primary/10 text-primary border-primary/…` treatment already used
   elsewhere on this page for icon chips; "alert/warning" tiles use the
   existing `destructive` token. Global `--primary` in
   `packages/agora/src/presentation/ui/globals.css` is **not** touched — that
   file is shared by every app in the workspace, not just Chrono.
2. **Pricing**: add a no-price teaser section (3 tiers, feature bullets, no
   numbers), reversing the archived plan's "not added" call now that the
   developer wants it.
3. **No fabricated customer facts** (unchanged from the archived plan): no
   testimonials, no invented usage/adoption metrics, no claims about real
   customers or company history Chrono doesn't have. The "Live Command Center"
   dashboard mockup is fine — it's an illustrative example screenshot (every
   SaaS marketing site ships one), not a claim about real usage — but it must
   be **visibly labeled as an example** (a badge reading "Example: Main
   Branch") so it can't be misread as a real metric.
4. **Currency-neutral copy.** oikos's copy is peso-denominated (`₱12,450`)
   because IZUR sells only in the Philippines. Chrono-on-Agora has no fixed
   currency (`.ai/rules/database.md` treats money as generic `numeric`), so
   the rebuilt copy counts things (sessions, payments, alerts) rather than
   naming a currency amount.
5. **oikos's "Mobile App Preview" and "Brand Positioning Strip" sections are
   cut, not ported.** Chrono has no mobile app (`apps/chrono-mobile` is
   explicitly out of scope for this migration pass per
   `apps/chrono-api/AGENTS.md`) — previewing one would overpromise. The trust
   strip's claims ("Built and supported by IZUR", "tested through real cafe
   workflows") aren't true of this reimplementation yet and have no honest
   equivalent to substitute — cut rather than fabricate a replacement.
6. **CTAs link only to routes that exist today**: `/sign-up`, `/login`,
   `/contact`. oikos's `/demo` and `/register` do not exist in this app and are
   not being added by this plan — every "Book a demo"-style CTA becomes
   "Talk to us" → `/contact`.
7. **Implementation stays local, not delegated to Jules.** This phase is
   almost entirely visual/copy judgment calls best made with the dev server
   running and the page open in a browser (per the repo's UI-change
   verification expectation) — that iteration loop doesn't fit Jules's
   async, no-browser workflow well for a page this content-heavy.

## Pass 1 — Workflow Analysis

- **Who uses this**: an anonymous prospective venue operator evaluating
  Chrono, landing on the apex host (`CHRONO_DOMAIN`) exactly as the tenant-host
  branch's audience is a walk-in customer of one venue (unchanged, out of
  scope here).
- **Workflow**: lands on `/` → scans the Live Command Center mockup and
  problem/solution framing → checks the module list and comparison table →
  sees which plan tier fits → "Create a business" → `/sign-up` (unchanged
  provisioning flow) or "Talk to us" → `/contact` (existing route, existing
  `ContactForm`/`client.tsx`, untouched by this plan).
- **Failure cases**: this is a static, unauthenticated, read-only page with no
  new data fetch — the only existing fetch (`fetchTenant()`) already swallows
  errors and returns `null`, so the apex path is unaffected. No new required
  network call is introduced.
- **Audit/notifications**: none — presentation-layer only.

## Pass 2 — Technical Planning

- **No API, schema, contract, RLS, permission, or tenancy change.**
  `rls:proof` is unaffected but still run per the repo's before-you-finish
  checklist.
- **Component-first UI** (`.ai/rules/component-first-ui.md`): every section
  composes from `agora/ui` primitives. After reviewing what already exists
  (`Card`, `Grid`, `Stack`, `Row`, `Section`, `Badge`, `StatTile`, `FaqItem`,
  `Table*`, `SiteHeader`, `SiteFooter`, `ThemeToggle`, `BrandHeader`,
  `buttonVariants`), **exactly one new primitive is needed**:

  | New primitive | Why it earns a place in `agora/ui`, not the app |
  |---|---|
  | `SectionHeading` (`eyebrow`/`title`/`description`/`align`) | The current page already hand-rolls this exact `<Stack gap={2}><span className="text-xs uppercase …">…eyebrow…</span><h2 className="text-heading-md …">…title…</h2><p className="text-muted-foreground">…description…</p></Stack>` block **eight separate times**. It's a generic "marketing section header" pattern any business app's landing page would repeat (same reasoning `FaqItem`/`StatTile`/`Testimonial` already used to justify their place in the foundation) — not Chrono-specific. |

  Everything else oikos treats as a bespoke primitive (`BentoGrid`/
  `BentoCard`, `MetricCard`, `RoleCard`, its own `ComparisonTable`,
  `FaqAccordion`, `CtaSection`) is achievable with what already exists:
  - **Bento grid** (one card spanning 2 columns, rest spanning 1): `<Grid
    cols={3}>` already renders a plain CSS grid — giving the *first card*
    `className="md:col-span-2"` makes it span without any new grid component.
  - **KPI tiles with a "highlighted"/"warning" tone**: `StatTile` already
    accepts `className` (for the tile's border/background) and `value` as
    `ReactNode` (so a warning count can be wrapped in
    `<span className="text-destructive">`) — no change to `StatTile` itself.
  - **Role cards / comparison table / FAQ accordion / final CTA band**: all
    already directly composable from `Card`/`CardHeader`/`CardTitle`/
    `CardDescription`, `Table*`, `FaqItem`, and a `Section`, exactly as the
    current file already does for its Roles/Comparison/FAQ/CTA sections.
- **Icons**: `lucide-react`, already a dependency, same import style as today.
- **Nothing in `packages/agora` changes except adding `SectionHeading`** (new
  file + one export line). No other shared component, token, or route is
  touched.

### Files to update

| File | Change |
|---|---|
| `packages/agora/src/presentation/ui/components/custom/section-heading.tsx` | **New.** `SectionHeading` primitive. |
| `packages/agora/src/presentation/ui/index.ts` | Add `export { SectionHeading } from "./components/custom/section-heading"` (alongside the other `custom/` exports). |
| `apps/chrono-web/src/app/(saas-landing)/page.tsx` | Apex (`!tenant`) branch only: full section rewrite per the table below. |

**Confirmed out of scope, no change needed:**
`apps/chrono-web/src/app/layout.tsx` (already Chrono-branded metadata since
the archived plan), the tenant-host branch of the same `page.tsx`, every other
`(saas-landing)` route, `apps/agora-web/**`, and
`apps/chrono-web/e2e/tests/tenant-landing/*.spec.ts` (verified — both specs
exercise `/about` and its role gate, not `/`; no assertion pins the apex
copy this plan changes).

---

## Phase 1 — `SectionHeading` primitive

**Tasks**

1. Create `packages/agora/src/presentation/ui/components/custom/section-heading.tsx`:
   ```tsx
   import { cn } from "../../cn";
   import { Stack } from "./layout";

   export function SectionHeading({
     eyebrow,
     title,
     description,
     align = "left",
     className,
   }: {
     eyebrow?: string;
     title: string;
     description?: string;
     align?: "left" | "center";
     className?: string;
   }) {
     return (
       <Stack
         gap={2}
         className={cn(align === "center" && "items-center text-center", className)}
       >
         {eyebrow ? (
           <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
             {eyebrow}
           </span>
         ) : null}
         <h2 className="text-heading-md font-semibold tracking-tight sm:text-heading-lg">
           {title}
         </h2>
         {description ? (
           <p className="text-muted-foreground">{description}</p>
         ) : null}
       </Stack>
     );
   }
   ```
   (Matches the exact classes the current page already uses eight times —
   this is a pure extraction, not a new visual design.)
2. Export it from `packages/agora/src/presentation/ui/index.ts` next to
   `FaqItem`/`StatTile`/`Testimonial`.

**Acceptance criteria**

- `SectionHeading` renders identically to the hand-rolled block it replaces
  (same classes, same DOM shape modulo the wrapping element).
- Exported from `agora/ui` and importable as
  `import { SectionHeading } from "agora/ui"`.

**Verification**: `pnpm typecheck` (workspace-wide — this package is consumed
by both `agora-web` and `chrono-web`, so confirm neither breaks).

**Execution start point**:
`packages/agora/src/presentation/ui/components/custom/faq-item.tsx` (copy its
file shape/doc-comment style for the new file).

---

## Phase 2 — Apex homepage rebuild

**Section structure — current → new**

| # | Current section | New section (oikos-inspired, improved) |
|---|---|---|
| 1 | Hero: headline + subhead + 2 CTAs + 4 stat tiles | **Hero, kept + extended**: same headline slot (rewritten, see copy below), same 2 CTAs (`/sign-up`, `/contact` not `/demo`), same 4 `StatTile`s, **plus a new "Live Command Center" dashboard mockup panel** (oikos's signature visual, rebuilt from `Card`/`StatTile`/`Row`/`Badge` — see structure below) |
| 2 | *(none)* | *(Brand positioning strip — deliberately not added; see Decisions #5)* |
| 3 | Features: 6 module cards, `Grid cols={2}` | **Problem/Solution split, expanded**: 4-card "problem" grid (`Grid cols={2}`, destructive-tinted icon chips) directly above the existing 6-module bento, now `Grid cols={3}` with the first card spanning `md:col-span-2` |
| 4 | Without/With Chrono 2-card comparison | **Folded into the Problem/Solution framing above** — the old two-card list becomes the "problem" card copy; no separate section |
| 5 | Comparison table (6 rows) | **Kept as-is**, same 6 rows, same `Table*` primitives |
| 6 | Roles: 4-card `Grid cols={4}` | **Kept as-is** |
| 7 | Surfaces: 3-card `Grid cols={3}` | **Kept as-is** |
| 8 | How it works: 4 steps | **Extended to 5 steps** (add "Review the audit trail" as step 5) |
| 9 | *(none)* | **New: "Why it's built this way" section** — 1/3 statement + 2/3 four-card benefit grid (`Grid cols={2}` inside the 2/3 column) |
| 10 | *(none)* | **New: Pricing teaser** — 3 `Card`s, middle one marked recommended (`border-primary`), no numeric prices, `/contact` CTA on each |
| 11 | FAQ: 6 `FaqItem`s | **Extended to 7** (add a data-isolation question) |
| 12 | Final CTA | **Kept, copy tightened** |
| — | `SiteHeader` nav: `Features` anchor only | Add a `Pricing` anchor (`#pricing`) next to `Features` (`#features`) |

**Tasks**

1. **Hero** (`SiteHeader` unchanged; hero `Section` restructured to 2-column
   on `lg:` — text column + mockup column, stacking on mobile):
   - Badge: `Chrono · Venue management platform`
   - H1: `One dashboard for every branch, every session, every shift.`
   - Subhead: `Chrono gives multi-branch venue operators real-time visibility into stations, wallets, staff shifts, and reservations — so nothing gets tracked on a whiteboard again.`
   - CTAs: `Create a business` → `/sign-up` (primary), `Talk to us` → `/contact` (outline) — replaces the current `/login` secondary CTA (sign-in stays reachable from the header's own `Sign in` link).
   - Keep the existing 4 `StatTile`s (`stats` array) unchanged.
   - **New**: below or beside the text column, a `Card`-based mockup:
     - Header row: a small pulsing dot (`<span className="h-2 w-2 rounded-full bg-primary animate-pulse" />`) + `Live Branch Command Center` label + `<Badge variant="secondary">Example: Main Branch</Badge>`.
     - `<Grid cols={4} gap={3}>` of 4 `StatTile`s: `Active Sessions` (18), `Available Stations` (7), `Payments Recorded Today` (24), `Open Alerts` (`<span className="text-destructive">3</span>`, `className="border-destructive/30"` on that tile).
     - Below: a 2-column split — left: 3 `Row`s of station status (`Station 01 — Active`, badge `42m left`; `Station 02 — Available`, `variant="outline"`; `Station 03`, badge `variant="destructive"` `Awaiting payment`), right: a 3-item activity feed (`Stack` of small bullet `Row`s: "Payment confirmed — Station 03", "Shift opened — front desk", "Reservation checked in — Station 07").
2. **Problem section** (new, `Grid cols={2}`, `AlertCircle` icon in a
   `bg-destructive/10 text-destructive` chip): 4 cards — *Manual tracking gets
   messy*, *Owners lack branch visibility*, *Staff actions need
   accountability*, *Multi-branch data gets tangled* (exact copy drafted at
   implementation time, following the tone of the existing `withoutChrono`
   array).
3. **Modules bento**: reuse/extend the existing `highlights` array to 6 items
   — Station Session Control, Wallet & Credits, Staff Shifts & Cash
   Reconciliation, Branch Monitoring, Reservations, Audit Trail — render in
   `<Grid cols={3}>` with the first `Card` given `className="md:col-span-2"`.
4. **Comparison table**: unchanged, reuse `comparisonRows` verbatim.
5. **Roles / Surfaces**: unchanged, reuse `roles` and the surfaces cards
   verbatim.
6. **How it works**: extend `steps` to 5 — append `Review the audit trail` /
   "See every session, sale, and cash movement tied back to the shift that made it."
7. **New "Why it's built this way" section**: `Section` with a 3-column
   layout (`Grid`-equivalent via a 1/3 + 2/3 split — implement as
   `<div className="grid gap-8 lg:grid-cols-3">` is **not** allowed by
   component-first-ui; use `<Row>`/`<Grid>` composition instead, e.g. a
   `Grid cols={3}` where the statement lives in the first cell and the
   benefit grid occupies the remaining visual weight via `Grid cols={2}`
   nested for the 4 benefit cards). Benefits: *Cleaner floor operations*,
   *Full visibility*, *A better customer experience*, *Built to grow*.
8. **Pricing teaser** (new, `id="pricing"`): `SectionHeading` + `Grid
   cols={3}` of 3 `Card`s — `Single Branch`, `Growing Business` (recommended,
   `className="border-primary/40"` + a small `Badge`), `Multi-Branch` — each
   with a `CardDescription` + a bullet feature list (`Stack` of `Row`s with a
   `Check` icon) + `CardFooter` with a `Talk to us` → `/contact` button. No
   numeric price anywhere.
9. **FAQ**: extend `faqs` to 7 — add *"Is my data isolated from other
   businesses on the platform?"* → answer citing tenant-scoped row-level
   security enforced at the database.
10. **Final CTA**: keep structure, tighten copy to
    `Ready to run your business on one dashboard?` /
    `Create your business in seconds — set up branches and stations, invite your staff, and open the floor.`
11. **Nav**: add a `Pricing` anchor link (`href="#pricing"`) to `SiteHeader`'s
    `nav` prop, next to the existing `Features` anchor.

**Acceptance criteria**

- Every section renders from `agora/ui` primitives (`PageShell`, `SiteHeader`,
  `SiteFooter`, `Main`, `Section`, `Grid`, `Stack`, `Row`, `Card*`, `Badge`,
  `StatTile`, `FaqItem`, `Table*`, `SectionHeading`, `buttonVariants`,
  `ThemeToggle`) — no new raw `div`/`header`/`nav`/`section` chrome beyond the
  gradient/mask overlay wrappers the hero already has.
- No CTA links to a route that doesn't exist (`/demo`, `/register` must not
  appear anywhere).
- No testimonial, no invented adoption/usage statistic presented as fact. The
  Live Command Center mockup's `Badge` reads "Example: …", not a claim about a
  real branch.
- No currency symbol/amount anywhere in new copy.
- Light and dark theme both render correctly (`ThemeToggle` still works); no
  hardcoded hex colors, only semantic token classes.
- `pnpm --filter @agora/chrono-web typecheck` passes with no unused imports.

**Verification**

```
pnpm --filter @agora/chrono-web typecheck
pnpm --filter @agora/chrono-web lint
```
Plus a visual pass with `pnpm --filter @agora/chrono-web dev` on the apex host
(`localhost:3000`), checked in both light and dark theme and at a mobile
viewport width, before calling this phase done.

**Execution start point**: `apps/chrono-web/src/app/(saas-landing)/page.tsx`,
the `highlights` array (~line 80) through the end of the `!tenant` branch
(~line 598).

---

## Phase 3 — Verify & commit

1. `turbo run typecheck` (whole workspace, catches any `agora/ui` export
   regression in `agora-web` too).
2. `pnpm --filter @agora/chrono-web lint`.
3. Visual pass in browser (light/dark/mobile) as above.
4. Commit Phase 1 and Phase 2 separately:
   - `feat(agora/ui): add SectionHeading primitive`
   - `feat(chrono/landing): rebuild apex homepage from oikos reference`
5. Move this plan to `.ai/plans/chrono/archive/saas-landing-rebuild/`.

## Out of scope (explicit)

- The tenant-host branch of `(saas-landing)/page.tsx` (the branded
  `{slug}.CHRONO_DOMAIN` mini-landing).
- `/about`, `/contact`, `/login`, `/sign-up`, and every other existing
  `(saas-landing)` route — none of their content changes.
- A real `/demo` page, a `ContactForm`/`DemoRequestForm` rework, reCAPTCHA, or
  any form-validation change — none of oikos's form code is touched.
- `apps/agora-web/**` (the neutral scaffold stays neutral).
- Any new color token, dark-only theme, or brand palette change in
  `packages/agora/src/presentation/ui/globals.css`.
- `apps/chrono-mobile` / any mobile-app marketing content.
