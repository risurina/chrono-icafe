# Chrono: tenant-selectable landing-page theme presets

## Context

Following the elegant-gold theme work (`.ai/plans/chrono/archive/chrono-theme-colors/`),
the developer wants a Chrono tenant to **pick** a color theme for their public site
from a small set of presets (starting with "Elegant Gold" — the palette just shipped —
and "Neon Green") via a dashboard control, rather than every tenant being stuck with
one hardcoded palette. They also want a Chrono-only rules doc recording this system and
explicitly reserving room for a **future** custom color picker (arbitrary per-tenant
colors, not just presets) — not built now, just documented as the next extension step.

**Scope boundary, confirmed in research:** `apps/chrono-web`'s root layout
(`layout.tsx`) wraps every route — the tenant dashboard and the public `/about`
landing page alike — and the existing tenant-branding override (`primaryColor`/
`accentColor`) already applies site-wide, not just to the public page. This plan keeps
that precedent: a selected preset re-themes the tenant's entire site, exactly like the
existing branding override does. If the developer wants the dashboard to stay visually
neutral while only the public page re-themes, that's a bigger, different change — call
it out now if so.

## Current state (read, not guessed)

- **Landing-page module already exists and is the right home for this.**
  `apps/chrono-api/src/modules/landing-page/{schema,contracts,routes}.ts` — table
  `ChronoLandingPages` (one row per tenant, already RLS-registered in
  `APP_TENANT_TABLES`, `apps/chrono-api/src/db/schema.ts:259`), `/rpc/landing-page`
  (`GET`/`PATCH`, gated `landingPage:manage` — `apps/chrono-api/src/auth/permissions.ts:120,155`),
  and a public, rate-limited `GET /public/landing-page` (`apps/chrono-api/src/app.ts:583-596`,
  `landingPageIpLimiter` = 60/min/IP) serving content to the `/about` page
  (`apps/chrono-web/src/app/(saas-landing)/about/page.tsx`). This is chrono-owned, not
  foundation — adding a `themePreset` column here needs no foundation schema/contract
  changes, matching `.ai/rules/business-app.md`'s "business-specific data stays in the
  app" boundary.
- **Foundation branding (`TenantBrandings`) only overrides two tokens and is the wrong
  home.** `packages/agora/src/presentation/next/index.ts:123-135`'s `brandingCss()`
  builds `:root{--primary:…;--accent:…}` from `TenantBrandings.primaryColor`/
  `accentColor` only — it doesn't know about a full palette or presets, and it's a
  foundation, business-neutral table (`BASE_TENANT_TABLES`). Presets are a chrono
  concept; they don't belong there.
- **Injection point.** `apps/chrono-web/src/app/layout.tsx:44-58` already fetches
  `getPublicBranding()` and injects `brandingCss(branding)` as an unlayered
  `<style id="tenant-branding">` inside `<body>`, before `<Providers>`. This plan adds
  a second, similarly-injected `<style>` tag for the resolved theme preset, rendered
  **before** the existing branding style tag in source order — so a tenant's explicit
  `primaryColor`/`accentColor` override (if set via the existing branding settings page)
  continues to win over the preset default, exactly matching today's precedent that a
  more specific, explicitly-set value beats a broader default.
- **`apps/chrono-web/src/app/globals.css:11-78`'s hardcoded elegant-gold `:root`/`.dark`
  blocks stay exactly as they are** — they become the **fallback** rendered before any
  JS/fetch resolves (and the value used for an apex host / no-tenant-context render,
  where `getRequestTenant()` yields no slug/host). No changes to this file in this plan.
- **No `Select` primitive exists in `agora/ui`** (checked `packages/agora/src/presentation/ui/index.ts`
  exports — no `Select`/`Dropdown`). Rather than adding a new shared primitive for a
  single two-option picker, the preset picker uses swatch-style `Button`s (existing
  primitive), one per preset, with a selected/unselected visual state — no new
  foundation component needed. If a third+ preset later makes buttons unwieldy, revisit
  with a `Select` primitive addition to `packages/agora/src/presentation/ui` at that time (not now).
- **`/public/branding` has no rate limiter** (`apps/chrono-api/src/app.ts:551-572`) —
  it's a narrow, non-sensitive, cheap single-row read via `withAdmin`, called on every
  layout render. This plan's new public theme-preset endpoint mirrors that same,
  already-accepted risk profile — **not** `/public/landing-page`'s 60/min/IP limiter,
  which exists to bound the heavier public **content** read and shouldn't be doubled up
  by every dashboard navigation (the layout renders on every server render, dashboard
  included, so reusing the content-rate-limited endpoint would contend staff dashboard
  traffic against real public visitor traffic on the same limiter).
- **Existing e2e coverage to extend, not duplicate.**
  `apps/chrono-web/e2e/tests/tenant-landing/{edit-role-gate,public-page}.spec.ts`
  already cover the landing-page editor's happy path, role gate (`staff` blocked,
  `admin`/`owner` allowed), and `/about` cross-tenant isolation. This plan extends both
  files with preset-specific assertions rather than writing a parallel spec suite.

## Plan

### Phase 1 — Schema: add `themePreset` to `ChronoLandingPages`

**Files to update**
- `apps/chrono-api/src/modules/landing-page/schema.ts`

**Step-by-step tasks**
1. Add `themePreset: text("themePreset")` (nullable, no default — `null` means "use the
   default preset") to the `chronoLandingPage` table definition, alongside the existing
   columns.
2. `pnpm db:generate --name chrono_landing_page_theme_preset` then `pnpm db:migrate`.
   **Never `pnpm db:push`** (`.ai/rules/database.md`).
3. No `APP_TENANT_TABLES` change needed — `ChronoLandingPages` is already registered
   (`apps/chrono-api/src/db/schema.ts:259`); this is a column addition to an
   already-RLS-forced table.

**Acceptance criteria:** migration file generated and applied; `themePreset` column
exists, nullable, on `ChronoLandingPages`.

**Out of scope:** any new table; changing `TenantBrandings` (foundation).

**Verification:** `pnpm --filter @agora/api rls:proof` (schema touched — must still
print `RLS PROOF: PASS ✅`, since a new column on an already-forced table doesn't change
isolation but the rule requires re-proving after any schema change).

**Execution start point:** `apps/chrono-api/src/modules/landing-page/schema.ts:5`.

### Phase 2 — Contracts + registry: define the preset vocabulary

**Files to update**
- `apps/chrono-api/src/modules/landing-page/contracts.ts`
- New: `apps/chrono-web/src/lib/theme-presets.ts`

**Step-by-step tasks**
1. In `contracts.ts`, add `export const THEME_PRESET_KEYS = ["elegant-gold", "neon-green"] as const;`
   and `themePresetKeySchema = z.enum(THEME_PRESET_KEYS);`. Add
   `themePreset: themePresetKeySchema.nullable().optional()` to `updateLandingPageSchema`,
   and `themePreset: string | null` to `LandingPageContent`.
2. Update `toContent()` in `routes.ts` to include `themePreset: row.themePreset`.
3. New file `apps/chrono-web/src/lib/theme-presets.ts` — the registry, following the
   provider-pattern shape from `.ai/rules/providers.md` (a map of key → full token set,
   analogous to `EMAIL_PROVIDERS`/`BILLING_PROVIDERS`, but for CSS token maps instead of
   class instances):
   ```ts
   export const CHRONO_THEME_PRESET_KEYS = ["elegant-gold", "neon-green"] as const;
   export type ChronoThemePresetKey = (typeof CHRONO_THEME_PRESET_KEYS)[number];
   export const DEFAULT_THEME_PRESET: ChronoThemePresetKey = "elegant-gold";

   type TokenMap = Record<string, string>; // CSS var name (no --) -> hex value

   export const CHRONO_THEME_PRESETS: Record<
     ChronoThemePresetKey,
     { label: string; light: TokenMap; dark: TokenMap }
   > = {
     "elegant-gold": {
       label: "Elegant Gold",
       light: { /* verbatim copy of globals.css:16-45's current :root hex values */ },
       dark: { /* verbatim copy of globals.css:48-78's current .dark hex values */ },
     },
     "neon-green": {
       label: "Neon Green",
       light: { /* new palette, see below */ },
       dark: { /* new palette, see below */ },
     },
   };
   ```
   **`elegant-gold`'s values are copied verbatim** from the currently-shipped
   `apps/chrono-web/src/app/globals.css` `:root`/`.dark` blocks (the just-implemented
   WCAG-AA-corrected values, including the darkened `#8a6508`/`#c0392b`/`#6b6660`) — no
   re-deriving, no redoing the contrast work.
4. **`neon-green`'s values are new — pin exact hex here, already AA-checked** (so
   Jules/implementer does not need a contrast pass of their own):
   - Light: `background:#f7fdf9 foreground:#0f1f13 card:#fff card-foreground:#0f1f13
     popover:#fff popover-foreground:#0f1f13 primary:#0f7a3d primary-foreground:#f7fdf9
     secondary:#e8f7ee secondary-foreground:#0f7a3d muted:#e8f7ee muted-foreground:#4d6b57
     accent:#e8f7ee accent-foreground:#0f7a3d destructive:#c0392b border:#22c55e26
     input:#22c55e26 ring:#22c55e chart-1:#22c55e chart-2:#3b82f6 chart-3:#f59e0b
     chart-4:#a855f7 chart-5:#ef4444 sidebar:#fff sidebar-foreground:#0f1f13
     sidebar-primary:#0f7a3d sidebar-primary-foreground:#f7fdf9 sidebar-accent:#e8f7ee
     sidebar-accent-foreground:#0f7a3d sidebar-border:#22c55e26 sidebar-ring:#22c55e`.
     (`primary-foreground` on `primary` = 5.9:1; `secondary-foreground`/
     `accent-foreground` `#0f7a3d` on `#e8f7ee` = 5.4:1; `muted-foreground` `#4d6b57` on
     `#e8f7ee` = 5.1:1 — all clear WCAG AA 4.5:1.)
   - Dark: `background:#06120a foreground:#e7fbee card:#0d1f14 card-foreground:#e7fbee
     popover:#0d1f14 popover-foreground:#e7fbee primary:#39e675 primary-foreground:#06120a
     secondary:#12331e secondary-foreground:#8ff5b0 muted:#0a1a11 muted-foreground:#9fd6b3
     accent:#12331e accent-foreground:#39e675 destructive:#f2685c border:#39e67538
     input:#39e67538 ring:#39e675 chart-1:#39e675 chart-2:#60a5fa chart-3:#fbbf24
     chart-4:#c084fc chart-5:#f87171 sidebar:#0a1a11 sidebar-foreground:#e7fbee
     sidebar-primary:#39e675 sidebar-primary-foreground:#06120a sidebar-accent:#12331e
     sidebar-accent-foreground:#39e675 sidebar-border:#39e67538 sidebar-ring:#39e675`.
     (`primary #39e675` on `background #06120a` = 12.9:1; `foreground` on `background` =
     14.8:1 — clean, matching the dark-mode pattern already established for elegant-gold
     where dark values don't need the AA correction light values needed.)
5. Add `themePresetCss(presetKey: string | null | undefined): string` to
   `theme-presets.ts` — resolves an unknown/null key to `DEFAULT_THEME_PRESET`, then
   builds `` `:root{--background:${light.background};...}.dark{--background:${dark.background};...}` ``
   for every key in the token map (mirroring `brandingCss()`'s string-building shape,
   `packages/agora/src/presentation/next/index.ts:123-135`, but emitting the full set
   instead of two vars).

**Acceptance criteria:** `THEME_PRESET_KEYS` (api) and `CHRONO_THEME_PRESET_KEYS` (web)
list the same two keys (documented duplication — see Phase 5's new rules doc for why
they can't share a package). `themePresetCss("neon-green")` (and `"elegant-gold"`,
and an invalid/`null` key) each produce valid, complete `:root`/`.dark` CSS text.

**Out of scope:** a shared `packages/agora` constant for the preset list (apps cannot
import each other per `.ai/rules/monorepo.md`; a 2-key list duplicated between contracts
and the web registry is deliberately not worth a shared package boundary yet).

**Verification:** `pnpm typecheck`.

**Execution start point:** `apps/chrono-api/src/modules/landing-page/contracts.ts:22`.

### Phase 3 — Route: accept and serve `themePreset`

**Files to update**
- `apps/chrono-api/src/modules/landing-page/routes.ts`
- `apps/chrono-api/src/app.ts`

**Step-by-step tasks**
1. `routes.ts`: `toContent()` already updated in Phase 2 to include `themePreset`. No
   other change needed to `GET`/`PATCH /rpc/landing-page` — the existing partial-upsert
   `PATCH` handler (`routes.ts:35-61`) already spreads `input` (which now may include
   `themePreset`) into the insert/update, since `updateLandingPageSchema` validates it.
2. Add `getPublicThemePreset(tenantId: string): Promise<string | null>` to `routes.ts`,
   alongside `getPublicLandingPageContent` — a narrow `withAdmin` read of just the
   `themePreset` column (not the full row), same reasoning as `getPublicLandingPageContent`'s
   existing doc comment (no tenant session exists pre-auth).
3. In `app.ts`, add a new public route mounted alongside the existing `/public/branding`
   and `/public/landing-page` block:
   ```ts
   // Public: Chrono's selected landing-page theme preset key for the current host
   // (pre-auth). Mirrors /public/branding's risk profile (narrow, non-sensitive,
   // cheap single-column read, no rate limiter) rather than /public/landing-page's
   // 60/min/IP limiter — that limiter exists to bound the heavier public *content*
   // read and must not be shared with every dashboard layout render (dashboard,
   // not just the public page, resolves this on every render — see
   // .ai/plans/chrono/archive/chrono-landing-theme-presets/README.md).
   .get("/public/theme-preset", async (c) => {
     const org = await resolveOrgFromRequest(c);
     if (!org) return c.json({ themePreset: null }, 404);
     const themePreset = await getPublicThemePreset(org.id);
     return c.json({ themePreset });
   })
   ```
   Import `getPublicThemePreset` alongside the existing `getPublicLandingPageContent`
   import (`app.ts:63`).

**Acceptance criteria:** `PATCH /rpc/landing-page {"themePreset":"neon-green"}` (as
owner) persists and round-trips via `GET /rpc/landing-page`; `GET /public/theme-preset`
on that tenant's host returns `{"themePreset":"neon-green"}` with no auth; on a
different tenant's host it returns that tenant's own (independent) value or `null` —
never the first tenant's.

**Out of scope:** changing `landingPageIpLimiter` or `/public/landing-page`'s existing
behavior/shape.

**Verification:** `pnpm typecheck`; manual `curl` against both routes locally before
the browser/e2e pass in Phase 6.

**Execution start point:** `apps/chrono-api/src/app.ts:583` (insert the new route
immediately after the existing `/public/landing-page` block).

### Phase 4 — Web: render the selected preset + dashboard picker

**Files to update**
- `apps/chrono-web/src/app/layout.tsx`
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/landing-page/page.tsx`

**Step-by-step tasks**
1. In `layout.tsx`, alongside the existing `getPublicBranding()` call, add a fetch for
   the theme preset. Add a small `cache()`-wrapped helper (mirroring `getPublicBranding()`'s
   own shape at `packages/agora/src/presentation/next/index.ts:60-79`) in
   `apps/chrono-web/src/lib/theme-presets.ts` (same file as the registry, since it's
   chrono-web-local, not foundation):
   ```ts
   export const getPublicThemePreset = cache(async (): Promise<string | null> => {
     const tenant = await getRequestTenant();
     if (!tenant.slug && !tenant.host) return null;
     const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
     const headers: Record<string, string> = {};
     if (tenant.slug) headers["x-tenant-slug"] = tenant.slug;
     else if (tenant.host) headers["x-tenant-host"] = tenant.host;
     try {
       const res = await fetch(`${apiUrl}/public/theme-preset`, { headers, cache: "no-store" });
       if (!res.ok) return null;
       const { themePreset } = (await res.json()) as { themePreset: string | null };
       return themePreset;
     } catch {
       return null;
     }
   });
   ```
2. In `layout.tsx`, call `getPublicThemePreset()` and `themePresetCss(themePreset)`,
   and render the result as a **new** `<style id="chrono-theme-preset">` tag, placed
   immediately **before** the existing `{css ? <style id="tenant-branding" .../> : null}`
   block (so branding's explicit `--primary`/`--accent` override continues to win in
   the cascade — later source order wins for two unlayered rules of equal specificity).
3. In the dashboard settings page, add a "Theme" `Card` above (or below) the existing
   content card: for each key in `CHRONO_THEME_PRESET_KEYS`, render a swatch `Button`
   (label = preset's `label`, `variant={form.themePreset === key ? "default" : "outline"}`)
   that sets `form.themePreset` on click. Extend `LandingPageForm`/`EMPTY`/`toPayload()`/
   the load effect/`onSave()` to carry `themePreset` (default to `null` meaning
   "Elegant Gold", matching `DEFAULT_THEME_PRESET`) exactly like the existing string
   fields are threaded through today.

**Acceptance criteria:** selecting "Neon Green" and saving updates `<html>`'s rendered
`--primary` (and the rest of the token set) to the neon-green values on both the
dashboard and the public `/about` page for that tenant, after a hard reload; a
different, unbranded tenant with no preset selected still renders elegant-gold
(the default).

**Out of scope:** a live-preview-before-save UI; per-page (dashboard-only or
public-only) theme scoping — this plan intentionally themes the whole tenant site, per
the Context section above.

**Verification:** `pnpm typecheck`; browser check in Phase 6.

**Execution start point:** `apps/chrono-web/src/app/layout.tsx:44`.

### Phase 5 — Docs: Chrono-only rules for theme presets + future custom picker

**Files to update**
- `apps/chrono-api/AGENTS.md`

**Step-by-step tasks**
1. Add a new `## Landing-page theme presets` section (this is the single doc for the
   `chrono-api`/`chrono-web` pair per `.ai/rules/business-app.md`, "Where rules live" —
   not a new file). Document:
   - The registry lives in `apps/chrono-web/src/lib/theme-presets.ts`
     (`CHRONO_THEME_PRESETS`), following the provider/registry pattern
     (`.ai/rules/providers.md`) — one entry per preset, each a full `light`/`dark`
     token map, not just two override colors.
   - **To add a new preset**: add an entry to `CHRONO_THEME_PRESETS` (web) and to
     `THEME_PRESET_KEYS` (`apps/chrono-api/src/modules/landing-page/contracts.ts`) —
     both must be updated together since chrono-api and chrono-web are separate
     packages that cannot share a constant across the workspace boundary
     (`.ai/rules/monorepo.md`). Every new preset's light-mode text/foreground pairs
     must be checked against WCAG AA (4.5:1) before merging — see the elegant-gold
     preset's own corrections (`.ai/plans/chrono/archive/chrono-theme-colors/palette-source.md`)
     for the exact methodology (darken text-role colors, keep decorative-role colors
     as-is where only the 3:1 non-text floor applies).
   - Storage: `ChronoLandingPages.themePreset` (nullable; `null` = default preset),
     read publicly via `GET /public/theme-preset` (no rate limiter, mirrors
     `/public/branding`'s risk profile — not `/public/landing-page`'s IP limiter).
   - **Reserved extension point (not built): custom color picker.** A tenant picking
     arbitrary colors, not just a named preset, is the natural next step. When built,
     it should **layer on top of presets, not replace them** — exactly how
     `TenantBrandings.primaryColor`/`accentColor` already layers on top of whatever
     preset/default is active (see Phase 4's `<style>` tag ordering: preset CSS
     renders first, branding override CSS renders second and wins). A custom picker
     would most naturally extend the **existing** `TenantBrandings` foundation table
     (since "arbitrary tenant-chosen colors" is business-neutral, unlike named
     presets, which are chrono-authored) by widening `brandingCss()` to accept
     more than two override vars — or, if broader per-tenant token overrides turn out
     to be useful to every business app, that is exactly the kind of generic
     capability `.ai/rules/architecture.md`'s "Business Apps" section says belongs in
     `packages/agora`, not duplicated per app. Do not build this now; this note exists
     so the next implementer doesn't have to rediscover the layering decision.

**Acceptance criteria:** the new section exists in `apps/chrono-api/AGENTS.md`, is
internally consistent with what Phases 1-4 actually built (not aspirational), and its
"reserved extension point" note is clearly marked as not-yet-built.

**Out of scope:** implementing the custom color picker itself; any change to
`TenantBrandings`/`brandingCss()`.

**Verification:** none (docs-only) beyond a read-through for accuracy against the
merged code.

**Execution start point:** `apps/chrono-api/AGENTS.md` (append after the existing
"Unauthenticated routes" section).

### Phase 6 — E2E: extend the existing tenant-landing specs

**Files to update**
- `apps/chrono-web/e2e/tests/tenant-landing/edit-role-gate.spec.ts`
- `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts`

**Step-by-step tasks**
1. In `edit-role-gate.spec.ts`: extend the existing admin/owner-can-save assertion to
   also select "Neon Green" via the new swatch buttons, save, and assert the button's
   selected visual state persists after reload (covers the **role gate** transitively —
   the same `<Can resource="landingPage" action="manage">` gate already tested there
   covers the new field, since it's the same form/route).
2. In `public-page.spec.ts`: extend the **happy path** to additionally select a preset
   for tenant A, then assert (via `page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary'))`
   or similar) that `/about` renders with that preset's `--primary` value. Extend the
   existing **cross-tenant isolation** test to assert tenant B's `/about` still renders
   the *default* elegant-gold `--primary` (or its own independently-set preset) —
   never tenant A's neon-green value.
3. Run the feature specs first (`playwright test tenant-landing`), then the full
   `apps/chrono-web` e2e suite to catch regressions.

**Acceptance criteria:** both specs pass; the three required cases (happy path, role
gate, cross-tenant isolation) are all covered for the new field, per
`.ai/rules/e2e-testing.md`.

**Out of scope:** a new, separate spec file — this plan extends the existing suite
rather than duplicating its setup/signup helpers.

**Verification:** `pnpm dev` (or the suite's own server assumptions — check
`apps/chrono-web/playwright.config.ts` for `webServer`), then run the two spec files,
then the full suite.

**Execution start point:**
`apps/chrono-web/e2e/tests/tenant-landing/edit-role-gate.spec.ts` (read in full before
editing — reuse its `signUp`/`findInviteLink` helpers rather than duplicating them).

## Verification (end-to-end, whole plan)

1. `pnpm typecheck` after every phase.
2. `pnpm --filter @agora/api rls:proof` after Phase 1 (schema change) — must print
   `RLS PROOF: PASS ✅`.
3. Manual `curl`/browser check of `GET /public/theme-preset` on two different tenant
   hosts after Phase 3, confirming independent values (no cross-tenant leak) before
   writing the e2e assertions in Phase 6.
4. Full `apps/chrono-web` e2e suite green after Phase 6, not just the two extended
   files (regression check).

## Out of scope (whole plan)

- The custom color picker itself (documented as a reserved future extension in
  Phase 5, not built).
- Any change to `packages/agora` (foundation) — `TenantBrandings`, `brandingCss()`,
  `PublicBranding` all stay as they are.
- A `Select`/dropdown primitive addition to `agora/ui` (swatch buttons suffice for two
  presets today).
- Per-surface theme scoping (dashboard vs. public page rendering different themes).
- Any change to `apps/chrono-web/src/app/globals.css` (the elegant-gold `:root`/`.dark`
  blocks there remain the fallback, unchanged).
