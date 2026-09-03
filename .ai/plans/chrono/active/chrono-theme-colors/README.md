# Chrono-web: elegant-gold color theme + smooth dark/light transition

## Context

The developer wants `apps/chrono-web` to adopt the "elegant gold" color palette
from the karta-oikos/chrono prior-art product (live at
https://chrono.izur.com.ph/), **colors only** — no layout or component changes.
They also want the dark→light transition improved: the live oikos/chrono site's
theme switch looks "distorted."

Research pulled the real CSS custom properties straight from the live site's
built stylesheet (`palette-source.md`, committed alongside this plan — raw
extracted `:root`/`.dark` blocks + verbatim-vs-derived notes) and found the
root cause of the distorted transition: the site has **no uniform, global
color-transition rule** — only scattered per-element Tailwind
`.transition-colors` utilities. When `next-themes` flips the `.dark` class on
`<html>`, elements carrying the utility cross-fade while every other element
snaps instantly, producing a visibly uneven flash. We fix both problems in
`apps/chrono-web` only: swap the token *values* to the gold palette, and add
one global transition rule — correctly layered so it doesn't fight Tailwind's
own transition utilities — so every themed element animates together,
consistently.

`apps/chrono-web/src/app/globals.css` already exists specifically to hold
Chrono's own copy of the design tokens, overriding `agora/ui/globals.css`
(imported first in `layout.tsx:3-4`) — per its own header comment (lines 9-10)
this is the intended override point. No foundation (`packages/agora`) file
changes, no other app affected.

**Revision note (post plan-audit):** the plan-auditor's first pass returned
`NEEDS REVISION` on 6 items. All are folded in below: the transition rule now
nests inside `@layer base` (it was previously ambiguous and would have beaten
Tailwind's `utilities` layer, breaking Sheet/Dialog/Switch animations
app-wide); the light palette's three worst-offending text/foreground pairs are
darkened for WCAG AA; the tenant-branding override is documented and
verification is re-scoped to an unbranded tenant; a cold-load check is added;
`box-shadow`/`fill`/`stroke` are dropped from the transition property list
(they were fading focus rings); and two factual errors about `--radius` /
`--font-size-*` are corrected below.

## Current state (read, not guessed)

- `apps/chrono-web/src/app/globals.css:11-78` — Chrono's `:root`/`.dark`
  token blocks: same color values as the foundation defaults, but **not**
  identical overall — Chrono sets `--radius: 0.45rem` (foundation:
  `--radius: 0`, `packages/agora/src/presentation/ui/globals.css:39`) and has
  no `--font-size-*` tokens at all (those five lines exist only in the
  foundation file, lines 48-52, inherited via the earlier `agora/ui/globals.css`
  import in `layout.tsx:3` — Chrono's own file never redeclares them, so
  nothing here needs preserving/skipping in Chrono's own blocks).
- `apps/chrono-web/src/app/providers.tsx:10` — `next-themes` `ThemeProvider`
  with `attribute="class" defaultTheme="system" enableSystem`. No
  `disableTransitionOnChange` set (default `false` — transitions allowed,
  which is what we want for a smooth fade). `layout.tsx:48` already has
  `suppressHydrationWarning` on `<html>`, so next-themes' own
  before-hydration script (its standard no-flash mechanism) is already wired
  correctly — not touched.
- **Tenant branding overrides `--primary`/`--accent` and must be accounted
  for.** `layout.tsx:44-57` injects `brandingCss(branding)` as an unlayered
  `<style id="tenant-branding">` inside `<body>`, *before* `<Providers>`.
  `packages/agora/src/presentation/next/index.ts:123-130` shows it only emits
  a `:root{--primary:…;--accent:…}` rule when `branding.primaryColor` /
  `accentColor` are actually set on the tenant — on an unbranded tenant
  (the default) nothing is emitted and this plan's tokens apply untouched.
  This is **pre-existing, out-of-scope behavior**, not something this plan
  fixes — but it means verification must run against a tenant with no
  branding colors configured, and Phase 1's acceptance criterion is worded
  accordingly.
- `@layer base` in `globals.css:127-140` sets `* { border-color: var(--border) }`
  and `body { background-color / color }` — this is the layer the transition
  rule is nested inside (not appended outside it — see Phase 2).
- `--radius` and the (foundation-inherited) font-size tokens are **out of
  scope** per the developer's "colors only" instruction and stay as they are.

## Plan

### Phase 1 — Swap the token palette to elegant gold

**Files to update**
- `apps/chrono-web/src/app/globals.css` (`:root` block, lines 11-44; `.dark`
  block, lines 46-78)

**Step-by-step tasks**
1. Replace every color value in `:root` (light) with the gold-light palette
   (see `palette-source.md` for the raw extracted values and which of these
   are darkened from the source for WCAG AA):
   `background:#faf9f6` `foreground:#1c1917` `card:#fff`
   `card-foreground:#1c1917` `popover:#fff` `popover-foreground:#1c1917`
   `primary:#8a6508` `primary-foreground:#faf9f6` `secondary:#f5f5f4`
   `secondary-foreground:#8a6508` `muted:#f5f5f4` `muted-foreground:#78716c`
   `accent:#f5f5f4` `accent-foreground:#8a6508` `destructive:#c0392b`
   `border:#b8860b26` `input:#b8860b26` `ring:#b8860b`
   `chart-1:#b8860b` `chart-2:#10b981` `chart-3:#3b82f6` `chart-4:#f59e0b`
   `chart-5:#ef4444`. Map `sidebar*` onto the same surfaces as `card`/`accent`
   (the live site has no separate sidebar concept, so mirror card/accent —
   standard shadcn convention): `sidebar:#fff` `sidebar-foreground:#1c1917`
   `sidebar-primary:#8a6508` `sidebar-primary-foreground:#faf9f6`
   `sidebar-accent:#f5f5f4` `sidebar-accent-foreground:#8a6508`
   `sidebar-border:#b8860b26` `sidebar-ring:#b8860b`.

   Note the deviations from the raw source (documented in full in
   `palette-source.md`): `primary`, `secondary-foreground`,
   `accent-foreground`, `sidebar-primary`, `sidebar-accent-foreground` use the
   darker `#8a6508` instead of the source's `#b8860b` — the source value is
   ~3:1 contrast in these text/foreground roles and fails WCAG AA (4.5:1);
   `#8a6508` clears 4.5:1 in all of them. `#b8860b` is kept for the
   *decorative* roles (`ring`, `border`, `input`, `chart-1`) where only the
   3:1 non-text floor applies and it already clears that. `destructive` is
   darkened from the source's `#ef4444` to `#c0392b` (3.76:1 → passes 4.5:1 on
   both `card`/`background`) since it renders as text (error messages) more
   often than as a filled surface in this codebase's `agora/ui` components.
2. Replace every color value in `.dark` with the gold-dark palette (verbatim
   from the source — already clean contrast, 7.8–17.8:1):
   `background:#080806` `foreground:#f8f1e3` `card:#17140d`
   `card-foreground:#f8f1e3` `popover:#17140d` `popover-foreground:#f8f1e3`
   `primary:#d6a84f` `primary-foreground:#080806` `secondary:#201b10`
   `secondary-foreground:#f7d77a` `muted:#11100c` `muted-foreground:#b8aa90`
   `accent:#201b10` `accent-foreground:#d6a84f` `destructive:#d9534f`
   `border:#d6a84f38` `input:#d6a84f38` `ring:#d6a84f`
   `chart-1:#d6a84f` `chart-2:#34d399` `chart-3:#60a5fa` `chart-4:#fbbf24`
   `chart-5:#f87171`. `sidebar:#11100c` `sidebar-foreground:#f8f1e3`
   `sidebar-primary:#d6a84f` `sidebar-primary-foreground:#080806`
   `sidebar-accent:#201b10` `sidebar-accent-foreground:#d6a84f`
   `sidebar-border:#d6a84f38` `sidebar-ring:#d6a84f`.
3. Leave `--radius: 0.45rem` untouched (not a color token; out of scope). No
   `--font-size-*` lines exist in this file to worry about (see Current
   State) — do not add any.
4. Add a one-line comment above each block noting the source (elegant-gold
   palette, sourced from the karta-oikos/chrono live theme — see
   `../../../.ai/plans/chrono/active/chrono-theme-colors/palette-source.md`
   for raw values and the AA-contrast deviations), matching the file's
   existing comment style.

**Acceptance criteria**
- Every color CSS variable in both blocks is a hex value from the list above;
  no other variable (`--radius`) changed.
- On a tenant with **no branding colors configured** (the default seed
  tenant), `pnpm dev` renders the Chrono tenant dashboard in the gold palette
  in both light and dark. (A tenant with custom branding will show its own
  `--primary`/`--accent` instead — pre-existing, out-of-scope behavior from
  `brandingCss()`, not a regression from this change.)
- `primary-foreground` on `primary`, `secondary-foreground` on `secondary`,
  and `accent-foreground` on `accent` each measure ≥4.5:1 contrast in light
  mode (spot-check with any contrast checker against the hex pairs above).

**Out of scope:** any component/layout markup change, any `agora/ui`
foundation edit, the `.theme-elite` alt-theme seen in the source bundle (not
requested), fixing the pre-existing tenant-branding override behavior.

**Verification:** `pnpm typecheck` (CSS-only, but cheap and repo-standard).

**Execution start point:** `apps/chrono-web/src/app/globals.css:11`.

### Phase 2 — Fix the distorted transition with one correctly-layered rule

**Files to update**
- `apps/chrono-web/src/app/globals.css` (`@layer base`, lines 127-140)

**Step-by-step tasks**
1. Extend the existing `@layer base` block **in place** — nest the new rule
   inside the same `@layer base { … }` braces as the current `*`/`body`/
   `[data-density]` rules, not as a separate top-level block. This is load-
   bearing: Tailwind v4's `@import "tailwindcss"` (`globals.css:1`) declares
   `@layer theme, base, components, utilities` and unlayered CSS beats every
   layer regardless of specificity — a rule pasted outside `@layer base`
   would override every `transition-transform`/`transition-opacity`/
   `transition-all`/`duration-*` utility in the app (Sheet slide-in, Dialog
   overlay fade, Switch thumb, disclosure chevrons all use those utilities in
   `packages/agora/src/presentation/ui/components/{sheet,dialog,switch}.tsx`
   and `components/custom/{faq-item,sidebar-layout}.tsx`). Nesting inside
   `@layer base` keeps this rule in the lowest-precedence layer, so every
   Tailwind utility class continues to win exactly as before.

   ```css
   @layer base {
     * {
       border-color: var(--border);
     }

     @media (prefers-reduced-motion: no-preference) {
       *,
       *::before,
       *::after {
         transition-property: background-color, border-color, color;
         transition-timing-function: ease;
         transition-duration: 150ms;
       }
     }

     body {
       background-color: var(--background);
       color: var(--foreground);
       font-feature-settings: "rlig" 1, "calt" 1;
       font-size: var(--font-size-body);
     }
     [data-density="comfortable"] {
       font-size: var(--font-size-body-lg);
     }
   }
   ```

   Property list is deliberately narrowed to `background-color, border-color,
   color` only — the three properties the theme flip actually changes.
   `box-shadow`/`fill`/`stroke` are intentionally excluded: `box-shadow` backs
   Tailwind v4's `ring-*` utilities, so including it would fade in
   `:focus-visible` keyboard focus rings over 150ms instead of showing them
   instantly (an accessibility regression), and neither `fill` nor `stroke`
   is needed for this token set (no SVG icon recolors on theme switch here).
2. Do not touch `transform`/`opacity` — already excluded by the narrowed
   property list above, so Sheet/Dialog/Switch/chevron animations are
   unaffected by construction (verified below, not just asserted).
3. Existing per-element `.transition-colors` Tailwind utility usages are
   unaffected: they live in the `utilities` layer, which continues to
   override `@layer base` regardless of the new rule's presence.

**Acceptance criteria**
- Toggling the theme via `ThemeToggle`
  (`packages/agora/src/presentation/ui/components/custom/theme-toggle.tsx`,
  rendered in the dashboard header —
  `packages/agora/src/presentation/ui/components/custom/sidebar-layout.tsx:302`)
  fades background/border/text color together at the same ~150ms pace — no
  element visibly snapping instantly while others fade.
- No transition applied when the OS/browser has "reduce motion" enabled.
- **Regression check:** after the change, a Sheet still slides in
  (`transition-transform`), a Dialog overlay still fades
  (`transition-opacity`), and the Switch thumb still animates — all
  unaffected, confirmed by the Phase 9 verification below, not just by
  inspection of the CSS.
- Keyboard focus rings (`:focus-visible`) appear instantly, not faded in.

**Out of scope:** a `disableTransitionOnChange` prop change on
`ThemeProvider` (`providers.tsx:10`) — not needed since we want an animated
fade, not an instant snap; converting the property list to oklch (see the
existing hex format, kept for a 1:1 match with the source palette).

**Verification:** `pnpm typecheck`; manual/browser check described in the
end-to-end section below (includes the Sheet/Dialog/Switch regression check
and a cold-load-in-dark-mode check).

**Execution start point:** `apps/chrono-web/src/app/globals.css:127`.

## Verification (end-to-end)

This change adds no tenant-scoped table/route/resource, so the mandatory
3-case e2e spec (happy path / role gate / cross-tenant isolation) in
`.ai/rules/e2e-testing.md` does not apply — confirmed by plan audit: that
rule scopes the mandate to a new tenant-scoped table/resource, `/rpc` route,
or tenant dashboard *flow* change, none of which this touches. Verification
instead is a live browser smoke check:

1. `pnpm dev` (web :3000 + api :8787). Note `apps/chrono-web/playwright.config.ts`
   runs headed with no `webServer` declared, so `pnpm dev` must already be
   running before any Playwright-driven check below.
2. Open an **unbranded** tenant dashboard (`{slug}.localtest.me:3000/dashboard`,
   using a seed tenant with no `primaryColor`/`accentColor` set) via
   Playwright browser tools.
3. Confirm computed `background-color`/`color` on `<body>` match the new gold
   hex values in both light and dark (`getComputedStyle`).
4. Click `ThemeToggle` in the dashboard header and confirm: no console
   errors; the transition is visually uniform (screenshot before/mid/after,
   or check that background/border/text all report `transition-duration:
   0.15s` computed); a `Sheet` (if reachable from the current screen) still
   slides in; a `Dialog` overlay still fades; a `Switch` thumb still
   animates — i.e. the narrowed transition list did not regress these.
5. **Cold-load check:** with the OS/emulated color scheme set to dark,
   hard-reload the page and confirm there is no visible fade-in on first
   paint (the page should render directly in dark gold, not flash light-then-
   fade-to-dark). This guards against the exact class of distortion this
   plan sets out to fix reappearing on page load rather than on toggle.
6. Run `pnpm typecheck` — must stay green (CSS-only change, but confirms no
   accidental breakage).

## Out of scope (whole plan)

- Any other app (`apps/agora-web`, `apps/agora-api`, `packages/agora`).
- Layout, spacing, radius, typography, or component structure in
  `apps/chrono-web`.
- The `.theme-elite` alternate theme found in the live site's bundle.
- Any RLS/tenant/RBAC/schema work — none is touched by this change.
- Fixing the pre-existing tenant-branding `--primary`/`--accent` override
  behavior (documented above as a known, unrelated interaction).
