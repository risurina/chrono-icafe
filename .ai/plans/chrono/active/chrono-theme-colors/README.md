# Chrono-web: elegant-gold color theme + smooth dark/light transition

## Context

The developer wants `apps/chrono-web` to adopt the "elegant gold" color palette
from the karta-oikos/chrono prior-art product (live at
https://chrono.izur.com.ph/), **colors only** — no layout or component changes.
They also want the dark→light transition improved: the live oikos/chrono site's
theme switch looks "distorted."

Research (done, not repeated here) pulled the real CSS custom properties
straight from the live site's built stylesheet and found the root cause of the
distorted transition: the site has **no uniform, global color-transition
rule** — only scattered per-element Tailwind `.transition-colors` utilities.
When `next-themes` flips the `.dark` class on `<html>`, elements carrying the
utility cross-fade while every other element snaps instantly, producing a
visibly uneven flash. We fix both problems in `apps/chrono-web` only:
swap the token *values* to the gold palette, and add one global transition
rule so every themed element animates together, consistently.

`apps/chrono-web/src/app/globals.css` already exists specifically to hold
Chrono's own copy of the design tokens, overriding `agora/ui/globals.css`
(imported first in `layout.tsx:3-4`) — per its own header comment (lines 9-10)
this is the intended override point. No foundation (`packages/agora`) file
changes, no other app affected.

## Current state (read, not guessed)

- `apps/chrono-web/src/app/globals.css:11-78` — Chrono's `:root`/`.dark`
  token blocks, currently identical to the foundation defaults (greyscale
  oklch, `--radius: 0.45rem`).
- `apps/chrono-web/src/app/providers.tsx:10` — `next-themes` `ThemeProvider`
  with `attribute="class" defaultTheme="system" enableSystem`. No
  `disableTransitionOnChange` set (defaults to `false`, i.e. transitions are
  allowed — correct, we want a smooth fade, not an instant snap).
  `layout.tsx:48` already has `suppressHydrationWarning` on `<html>`, so
  hydration-mismatch flash is already handled — not touched.
- `@layer base` in `globals.css:127-140` sets `* { border-color: var(--border) }`
  and `body { background-color / color }` — this is the layer we extend with
  the transition rule.
- `--radius` and all font-size tokens are **out of scope** per the developer's
  "colors only" instruction and stay at their current Chrono values.

## Plan

### Phase 1 — Swap the token palette to elegant gold

**Files to update**
- `apps/chrono-web/src/app/globals.css` (`:root` block, lines 11-44; `.dark`
  block, lines 46-78)

**Step-by-step tasks**
1. Replace every color value in `:root` (light) with the gold-light palette
   pulled from the live site's stylesheet:
   `background:#faf9f6` `foreground:#1c1917` `card:#fff`
   `card-foreground:#1c1917` `popover:#fff` `popover-foreground:#1c1917`
   `primary:#b8860b` `primary-foreground:#faf9f6` `secondary:#f5f5f4`
   `secondary-foreground:#b8860b` `muted:#f5f5f4` `muted-foreground:#78716c`
   `accent:#f5f5f4` `accent-foreground:#b8860b` `destructive:#ef4444`
   `border:#b8860b26` `input:#b8860b26` `ring:#b8860b`
   `chart-1:#b8860b` `chart-2:#10b981` `chart-3:#3b82f6` `chart-4:#f59e0b`
   `chart-5:#ef4444`. Map `sidebar*` onto the same surfaces as `card`/`accent`
   (the live site has no separate sidebar concept, so mirror card/accent —
   standard shadcn convention): `sidebar:#fff` `sidebar-foreground:#1c1917`
   `sidebar-primary:#b8860b` `sidebar-primary-foreground:#faf9f6`
   `sidebar-accent:#f5f5f4` `sidebar-accent-foreground:#b8860b`
   `sidebar-border:#b8860b26` `sidebar-ring:#b8860b`.
2. Replace every color value in `.dark` with the gold-dark palette:
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
3. Leave `--radius` and every `--font-size-*` line untouched (not a color
   token; out of scope).
4. Add a one-line comment above each block noting the source (elegant-gold
   palette, sourced from the karta-oikos/chrono live theme), matching the
   file's existing comment style.

**Acceptance criteria**
- Every color CSS variable in both blocks is a hex value from the list above;
  no other variable (`--radius`, font sizes) changed.
- `pnpm --filter @agora/chrono-web dev` (or root `pnpm dev`) renders the
  Chrono tenant dashboard in the gold palette in both light and dark.

**Out of scope:** any component/layout markup change, any `agora/ui`
foundation edit, the `.theme-elite` alt-theme seen in the source bundle
(not requested).

**Verification:** `pnpm typecheck` (this is CSS-only, but keep it in the
loop since it's cheap and repo-standard).

**Execution start point:** `apps/chrono-web/src/app/globals.css:11`.

### Phase 2 — Fix the distorted transition with one uniform rule

**Files to update**
- `apps/chrono-web/src/app/globals.css` (`@layer base`, lines 127-140)

**Step-by-step tasks**
1. Extend the existing `@layer base` block: add a `prefers-reduced-motion:
   no-preference`-guarded rule applying one consistent transition to every
   element's themeable properties:
   ```css
   @media (prefers-reduced-motion: no-preference) {
     *, *::before, *::after {
       transition-property: background-color, border-color, color, fill,
         stroke, box-shadow;
       transition-timing-function: ease;
       transition-duration: 200ms;
     }
   }
   ```
2. Do **not** touch `transform`/`opacity`/layout properties — scoped strictly
   to color-related properties so existing hover/scale/motion utilities
   elsewhere are unaffected.
3. Leave existing per-element `.transition-colors` Tailwind utility usages
   as-is; the universal rule and a utility class targeting the same element
   coexist fine (equal specificity, same properties/duration — no visual
   conflict), and CSS transitions don't fire on first paint (no prior value
   to animate from), so there's no flash-of-transition on initial load.

**Acceptance criteria**
- Toggling the theme (system → light/dark, or via any in-app toggle) fades
  every visible surface (background, card, border, text) at the same
  ~200ms pace — no element visibly snapping instantly while others fade.
- No transition applied when the OS/browser has "reduce motion" enabled.

**Out of scope:** a `disableTransitionOnChange` prop change on
`ThemeProvider` (`providers.tsx:10`) — not needed since we want an animated
fade, not an instant snap.

**Verification:** `pnpm typecheck`; manual/browser check described below.

**Execution start point:** `apps/chrono-web/src/app/globals.css:127`.

## Verification (end-to-end)

This change adds no tenant-scoped table/route/resource, so the mandatory
3-case e2e spec (happy path / role gate / cross-tenant isolation) in
`.ai/rules/e2e-testing.md` does not apply — there is no new resource to gate
or isolate. Verification instead is a live browser smoke check:

1. `pnpm dev` (web :3000 + api :8787).
2. Open a tenant dashboard (`{slug}.localtest.me:3000/dashboard`) via
   Playwright browser tools.
3. Confirm computed `background-color`/`color` on `<body>` match the new gold
   hex values in both light and dark (read via `getComputedStyle` or a
   snapshot).
4. Toggle the theme and confirm no console errors, and that the transition
   is visually uniform (screenshot before/mid/after, or check that multiple
   elements' `transition-duration` computed style all report `0.2s`).
5. Run `pnpm typecheck` — must stay green (CSS-only change, but confirms no
   accidental breakage).

## Out of scope (whole plan)

- Any other app (`apps/agora-web`, `apps/agora-api`, `packages/agora`).
- Layout, spacing, radius, typography, or component structure in
  `apps/chrono-web`.
- The `.theme-elite` alternate theme found in the live site's bundle.
- Any RLS/tenant/RBAC/schema work — none is touched by this change.
