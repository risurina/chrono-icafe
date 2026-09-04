# Chrono: landing-page rebuild — replicate the oikos design, config-driven

## Context

The developer wants `apps/chrono-web`'s **SaaS marketing landing page** and **per-tenant
public landing page** rebuilt to closely match the karta-oikos/chrono design, and made
**fully tenant-customizable** across four dimensions: content, theme, branding/logo, and
which sections appear.

Three standing directives shape every decision below (developer's words: *"just improve
it"*, *"make it best practise coding"*, *"make sure easy to customize in future
project"*), and they match this repo's own rule that oikos is **prior art, not a spec**
(`apps/chrono-api/AGENTS.md`). So: match the visual result, write the implementation
fresh, and make everything a future business app would want to change into
**configuration rather than code**.

**The reference source is local and was read directly:**
`/Users/risurina/karta/karta-tenant/apps/chrono-web` (+ its `chrono-api` /
`packages/oikos` siblings). This corrects `apps/chrono-api/AGENTS.md`, which names an
unreachable Windows path.

### What the reference already does well (keep)

- **Thin page + one component per section** — `(landing)/page.tsx` is 44 lines listing 15
  sections; `TenantLandingPage.tsx` lists 10. Reads like a table of contents.
- **A real per-tenant config model** — `TenantLanding` table (`jsonb config`), a typed
  `TenantLandingPageConfig`, a Zod schema (`packages/oikos/src/tenant/landing-schema.ts`),
  **industry content presets** with `{tenantName}` interpolation, and a layered
  `resolveTenantLandingConfig()` merge cascade (defaults ← stored ← preset ← tenant).
- **`react.cache()`d host resolver** feeding both `generateMetadata` and the page without
  a double fetch (per-tenant title/favicon/OG).
- **A publish gate** (`isPublished` + `publishedAt`) separating drafts from the live page.
- **`color-mix(in srgb, var(--primary), …)` "premium" utilities** — one accent token
  re-skins every glow/gradient/dot pattern. This is the re-skin lever.
- **`data-testid` discipline** on the tenant surface.

### What the reference does badly (explicitly do NOT port)

1. **Three near-identical headers and three near-identical footers, zero shared code** —
   each re-implements the same scroll effect; the two footers are line-for-line copies.
2. **Content hardcoded in JSX** at ~250 lines/section (`LandingHero.tsx` 251,
   `DashboardPreview.tsx` 249, the settings editor `public-page-client.tsx` **815**). They
   wrote a `Content.ts` abstraction and then didn't use it.
3. **Large dead-code surface** — an entire unreachable `saas/` variant (222 lines), a third
   unused header/footer set, 9 of 18 orphaned tenant sections, a lorem `[slug]` stub.
4. **Hardcoded colors bypassing their own token system** — `bg-[#080806]`, `bg-zinc-950`,
   `amber-500`, `rgba(26,26,28,.6)` inside `.glass-panel` itself.
5. **Raw HTML inside imported primitives** — both footers are ~95% raw `div`/`span`/`ul`.
6. **`any`-typed merge logic** — `Record<string, any>`, `.map((item: any) => …)`,
   `(config.contact as any)`, `} as any` on a fabricated session.
7. **Schema fields with no consumer** — `hidePlatformBranding`/`platformBrandingLabel`
   validated and stored but ignored by the footer; **`primaryColor`/`accentColor`
   persisted and never applied to any CSS variable**. The tenant page is the same
   gold-on-black as the SaaS page.
8. **No section visibility/ordering model at all** (grepped: zero hits) — order is
   hardcoded JSX. This is precisely the gap the developer asked to close.
9. **Dead-end mobile UX** — no mobile menu on the SaaS header; the tenant hamburger
   renders but has no handler.
10. **Font via render-blocking CSS `@import`** plus an `!important` `.font-chrono` class
    duplicating the `--font-chrono` token. Root layout hard-pins `dark` — no light mode.

### Where our repo stands today

- `apps/chrono-web/src/app/(saas-landing)/page.tsx` is a **964-line monolith** with ~11
  hardcoded const arrays and two branches: apex marketing (`:84-783`) and a tenant
  mini-landing (`:785-963`). **The tenant branch never reads `/public/landing-page`.**
- `apps/chrono-web/src/app/(saas-landing)/about/page.tsx` — the actual tenant landing —
  uses raw `div`/`main` with **no `SiteHeader`/`SiteFooter`**, an existing
  `component-first-ui` violation this rebuild fixes.
- `agora/ui`'s `SiteHeader` **cannot** express scroll-transparency (unconditional
  `border-b bg-background/80 backdrop-blur`, server component, no client boundary) and
  `SiteFooter` **cannot** express a multi-column layout (hard-coded single flex row).
- `ChronoLandingPages` has only 6 flat content columns; **no** sections model, **no**
  theme preset, **no** publish flag.
- A sibling plan, `.ai/plans/chrono/active/chrono-landing-theme-presets/README.md`, is
  already written and plan-audited twice (elegant-gold/neon-green presets, a
  `themePreset` column, `/public/theme-preset`). **It is folded into Phase 3 here rather
  than run separately** — do not re-litigate its architecture; execute it.

## Architecture

Four decisions carry this feature:

**1. A section registry is the customization seam.** A typed map of
`sectionKey → { component, defaultEnabled, order, label }`. Pages render by resolving an
ordered, filtered key list from tenant config against that registry — never a hardcoded
JSX list. Adding a section = one registry entry. Re-skinning for a future app = swap the
registry. This is the thing the reference lacks entirely and the direct answer to *"easy
to customize in future project."*

**2. Content lives in typed content modules, not JSX.** Each section reads a typed props
object; SaaS defaults live in a `content/` module, tenant values come from config merged
over those defaults by a typed resolver (the reference's cascade idea, properly typed —
no `any`).

**3. Theme is applied, not just stored.** The reference's fatal gap. The `.premium-*`
utilities are all `color-mix(… var(--primary) …)`, so writing `--primary` re-skins the
entire page. Phase 3 wires the theme preset **and** the existing
`TenantBrandings.primaryColor`/`accentColor` into real CSS variables via the existing
`brandingCss()` injection point in `layout.tsx`.

**4. One header, one footer, extended in the foundation.** `.ai/rules/component-first-ui.md`
is explicit: *"If a needed primitive does not exist, add it in
`packages/agora/src/presentation/ui` first — do not invent local shell wrappers in app
files."* Scroll-transparency and a multi-column footer are generic to any marketing site,
so they are foundation extensions (Phase 1), not chrono-local copies. **This is a
deliberate, rule-mandated deviation** from the "no foundation edits" instruction in the
original ask — flagged here rather than done silently.

**Where the config machinery lives:** chrono-owned
(`apps/chrono-api/src/modules/landing-page/`), because the *section vocabulary* is
chrono's (stations, rates, games). The machinery is written to be promotable: if a second
business app needs it, the resolver/registry shape moves to `packages/agora` unchanged.
Documented in Phase 11.

## Plan

Phases 1–6 build the **platform** (primitives, theme, schema, contracts, registry,
routes); Phases 7–11 build the **surface** (the two pages, the editor, e2e, docs).
Implementation can pause between 6 and 7 with everything still green.

### Phase 1 — Foundation primitives: scroll-aware header, multi-column footer

**Files:** `packages/agora/src/presentation/ui/components/custom/site-header.tsx`,
`site-footer.tsx`, `packages/agora/src/presentation/ui/index.ts`

**Tasks**
1. `SiteHeader`: add an opt-in `transparentUntilScroll?: boolean` (default `false`, so
   every existing caller is unchanged) and `scrollThreshold?: number` (default `8`, the
   reference's value). When enabled, the header becomes a **client component** that
   tracks scroll with a single `passive` listener on `window` (the reference binds both
   `window` and `document` — redundant; bind one) and swaps classes with
   `transition-[background-color,border-color,box-shadow,backdrop-filter] duration-500
   ease-out`, matching the reference's timing:
   - at top: `border-transparent bg-background/0 shadow-none backdrop-blur-none`
   - scrolled: `border-primary/10 bg-background/95 shadow-lg shadow-black/20 backdrop-blur-xl`
   Keep the existing server-rendered path when the flag is off — do not force a client
   boundary on current callers.
2. `SiteHeader`: add a real **mobile menu** (`mobileNav?: React.ReactNode`) — a
   `Sheet`-based drawer behind a hamburger below `md`. The reference has none on SaaS and
   a dead button on tenant; shipping nav links that silently vanish on mobile is a
   regression we will not copy.
3. `SiteFooter`: add `columns?: FooterColumn[]` (`{ heading, links: {label, href}[] }`)
   and `bottomBar?: React.ReactNode`, rendering a responsive
   `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` block above the existing brand/links row.
   Existing `brand`/`links` props keep working unchanged.
4. Export any new types from `index.ts`. All markup stays inside
   `packages/agora/src/presentation/ui/components/**` per the raw-HTML rule.

**Acceptance:** existing `SiteHeader`/`SiteFooter` callers (`(saas-landing)/page.tsx`,
`new-business/page.tsx`, and every `apps/agora-web` caller) render identically with no
prop changes; with the new props set, the header fades in on scroll and the footer renders
columns. No hardcoded hex — semantic tokens only.

**Verify:** `pnpm typecheck`. **Out of scope:** restyling existing callers.
**Start:** `packages/agora/src/presentation/ui/components/custom/site-header.tsx:9`.

### Phase 2 — Brand system: typography, premium utilities, owl asset

**Files:** `apps/chrono-web/src/app/layout.tsx`,
`apps/chrono-web/src/app/globals.css`, `apps/chrono-web/public/brand/` (new)

**Tasks**
1. Load **Bruno Ace SC** via `next/font/google` (`Bruno_Ace_SC`, `weight: "400"`,
   `subsets: ["latin"]`, `variable: "--font-chrono"`, `display: "swap"`) alongside the
   existing `Inter`. **Not** a CSS `@import` — the reference's approach is render-blocking
   and unhoisted. Add both variables to `<body>`.
2. Register `--font-chrono` in `globals.css`'s `@theme inline` block so `font-chrono`
   becomes a real Tailwind utility. **No `!important`**, no separate `.font-chrono` rule
   duplicating the token (the reference does both).
3. Port the **`.premium-*` utilities** into `globals.css` under `@layer utilities`,
   verbatim in behaviour but **token-only**: `.premium-text-gradient`, `.premium-gradient`,
   `.premium-glow`, `.premium-card-shadow`, `.premium-grid`, `.premium-dots`, `.glass-card`.
   Keep the reference's solid `var(--primary)` fallback line before each `color-mix()`
   line. Drop `.premium-glow-cyan`/`-violet` and `.glass-panel` — they hardcode `rgba()`
   literals and belong to the unused `theme-elite` variant.
4. Copy the owl mark to `apps/chrono-web/public/brand/chrono-owl.png` (from
   `/Users/risurina/karta/karta-tenant/apps/chrono-web/public/favicon/apple-icon-180x180.png`
   — the largest clean source; **no SVG exists** in the reference or on the live site).
   Render it with `next/image` at fixed dimensions, not a raw `<img>`.

**Acceptance:** `font-chrono` renders Bruno Ace SC with no layout shift and no
`!important`; each `.premium-*` utility visibly responds to a `--primary` change; no
hardcoded hex outside the `:root`/`.dark` token blocks.

**Verify:** `pnpm typecheck`; visually confirm the wordmark in Phase 7's browser pass.
**Out of scope:** the `theme-elite` alternate palette.
**Start:** `apps/chrono-web/src/app/layout.tsx:2`.

### Phase 3 — Schema + theme application (absorbs the theme-presets plan)

**Files:** `apps/chrono-api/src/modules/landing-page/schema.ts`, its migration,
`apps/chrono-web/src/lib/theme-presets.ts` (new), `apps/chrono-web/src/app/layout.tsx`

**Tasks**
1. Add to `chronoLandingPage`: `themePreset text` (nullable), `config jsonb` (default
   `{}`), `sections jsonb` (default `{}`), `isPublished boolean not null default false`,
   `publishedAt timestamp` (nullable). One migration for all of it.
2. `pnpm --filter @agora/chrono-api db:generate --name chrono_landing_page_config` then
   `pnpm --filter @agora/chrono-api db:migrate`. **Root `db:*` scripts point at the
   scaffold `@agora/api`, not chrono** (`package.json:18-19`) — the `--filter` is
   required. Never `db:push`.
3. No `APP_TENANT_TABLES` change — `ChronoLandingPages` is already registered
   (`apps/chrono-api/src/db/schema.ts:259`).
4. Implement the **theme-preset registry + CSS injection exactly as specified** in
   `.ai/plans/chrono/active/chrono-landing-theme-presets/README.md` (Phases 2–4 of that
   plan): `CHRONO_THEME_PRESETS` with the AA-corrected `elegant-gold` and `neon-green`
   palettes, `themePresetCss()` returning `""` for the default case, the
   `readThemePresetForTenant` API helper, the rate-limited `/public/theme-preset` route,
   and the `<style id="chrono-theme-preset">` tag injected **before** the existing
   `tenant-branding` style tag with both fetches in `Promise.all`. That plan carries the
   audited hex values and the layering rationale — follow it rather than re-deriving.
5. **Close the reference's worst gap:** ensure `TenantBrandings.primaryColor`/
   `accentColor` actually reach `--primary`/`--accent`. `brandingCss()`
   (`packages/agora/src/presentation/next/index.ts:123`) already emits them — confirm the
   cascade order makes them win over the preset, and that the `.premium-*` utilities
   therefore re-skin per tenant. The reference persists these and never applies them.

**Acceptance:** migration applied; a tenant with `themePreset: "neon-green"` renders green
`--primary` site-wide; a tenant that also set a custom `primaryColor` sees **their** color
win over the preset; `.premium-glow`/`-dots`/`-text-gradient` all follow it.

**Verify:** `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅` (schema
touched; chrono's own proof, not `@agora/api`'s); `pnpm typecheck`.
**Start:** `apps/chrono-api/src/modules/landing-page/schema.ts:13`.

### Phase 4 — Contracts + typed resolver

**Files:** `apps/chrono-api/src/modules/landing-page/contracts.ts`,
`apps/chrono-web/src/lib/landing-config.ts` (new)

**Tasks**
1. Define `landingConfigSchema` (Zod, `.strict()`, all fields optional with max-lengths),
   modelled on the reference's `TenantLandingPageConfigSchema` but trimmed to what we
   actually render: `hero { eyebrow, title, subtitle, primaryCta{label,href},
   secondaryCta{label,href} }`, `about { title, body }`, `amenities { title, body }`,
   `contact { email, phone, address, operatingHours }`, `faqs[]` (max 12),
   `seo { title, description }`. Reuse the existing `ctaHrefSchema` XSS guard
   (`contracts.ts:8-20`) for **every** href field — the reference validates only some.
2. Define `sectionsConfigSchema`: `{ order?: sectionKey[]; hidden?: sectionKey[] }` where
   `sectionKey` is a `z.enum` of the registry's keys. Ordering and visibility are separate
   so a future key added to the registry appears automatically without rewriting stored
   `order` arrays.
3. Keep the six existing flat columns as-is for backward compatibility; the resolver reads
   them as fallbacks under `config`. **Do not** drop or migrate them in this plan.
4. Write `resolveLandingConfig()` — a **fully typed** merge cascade (defaults ← the six
   legacy columns ← stored `config`), returning a total (non-partial) view model. The
   reference's equivalent is riddled with `any`; ours has none. Co-locate a unit test
   asserting each layer wins in the right order.
5. Extend `LandingPageContent` + `toContent()` to carry `config`, `sections`,
   `themePreset`, `isPublished`.

**Acceptance:** `resolveLandingConfig()` is total and `any`-free; an unknown/extra config
key is rejected by `.strict()`; every href field passes through `ctaHrefSchema`; the unit
test proves the cascade order.

**Verify:** `pnpm typecheck`; the new unit test.
**Out of scope:** industry/content presets (a documented Phase 11 future seam).
**Start:** `apps/chrono-api/src/modules/landing-page/contracts.ts:22`.

### Phase 5 — The section registry + content modules

**Files:** `apps/chrono-web/src/components/landing/registry.ts` (new),
`apps/chrono-web/src/components/landing/content/*.ts` (new),
`apps/chrono-web/src/components/landing/sections/*.tsx` (new)

**Tasks**
1. Define the registry:
   ```ts
   export type LandingSectionKey = "hero" | "preview" | "problems" | …;
   export interface LandingSectionDef<P = unknown> {
     key: LandingSectionKey;
     label: string;            // shown in the dashboard editor
     surface: "saas" | "tenant" | "both";
     defaultEnabled: boolean;
     defaultOrder: number;
     Component: React.ComponentType<P>;
   }
   export const LANDING_SECTIONS: Record<LandingSectionKey, LandingSectionDef>;
   export function resolveSections(cfg, surface): LandingSectionDef[]; // order + filter
   ```
   `resolveSections()` sorts by stored `order` then `defaultOrder`, drops `hidden`, and
   filters by `surface`. **Unknown stored keys are ignored, never thrown** — a key removed
   from the registry must degrade gracefully, same deny-safe posture as the repo's
   permission sanitization.
2. Move all SaaS copy out of JSX into `content/saas.ts` as typed const objects (the
   reference wrote this abstraction and then abandoned it). Tenant copy comes from
   `resolveLandingConfig()`.
3. Build the section components one file each, composed **only** from `agora/ui`
   primitives (`Section`, `Grid`, `Stack`, `Card*`, `StatTile`, `FaqItem`,
   `SectionHeading`, `Table*`, `Badge`, `Button`) — no raw `div`/`span`/`ul` chrome, which
   is the reference's biggest violation. Each takes one typed props object. Add
   `data-testid` on every section root and key interactive node (the reference does this
   only on tenant; we do both, and Phase 10 depends on it).
4. SaaS sections mirror the reference's 15: hero, dashboard preview, positioning strip,
   problems, solution, modules, roles, comparison, how-it-works, benefits, showcase,
   mobile preview, pricing, FAQ, final CTA. Tenant sections: hero, station availability,
   rates, specs, about, amenities, location/branches, FAQ, final CTA.

**Acceptance:** every section renders from props alone; no section file contains literal
marketing copy; `resolveSections()` unit-tested for order, hide, unknown-key, and
surface-filter behaviour; zero raw HTML chrome outside `packages/agora`.

**Verify:** `pnpm typecheck`; registry unit test.
**Start:** `apps/chrono-web/src/components/landing/registry.ts` (new file).

### Phase 6 — Routes

**Files:** `apps/chrono-api/src/modules/landing-page/routes.ts`,
`apps/chrono-api/src/app.ts`

**Tasks**
1. `PATCH /rpc/landing-page` already gates on
   `requirePermission(c.var.tenant.permissions, { landingPage: ["manage"] })`
   (`routes.ts:37`) and validates via the `.strict()` schema — extend the schema only; the
   gate and `withTenant` scoping are unchanged. Add `isPublished`/`publishedAt` handling
   (set `publishedAt` on the false→true transition).
2. Extend `getPublicLandingPageContent()` to return `config`, `sections`, `themePreset`,
   and to **return `null` content when `isPublished` is false** (draft edits must not leak
   to the public page). Note its `withAdmin` read **bypasses RLS** — the explicit
   `eq(chronoLandingPage.tenantId, tenantId)` filter is the only isolation on that path;
   state it in a comment.
3. Add `/public/theme-preset` with its own `themePresetIpLimiter` per the theme-presets
   plan (a dedicated bucket, not `landingPageIpLimiter`, since the layout hits it on every
   dashboard render too).

**Acceptance:** a `staff` PATCH 403s; an unpublished tenant's `/public/landing-page`
returns null content; tenant A's config never appears for tenant B.

**Verify:** `pnpm typecheck`; `curl` both public routes against two tenant hosts.
**Start:** `apps/chrono-api/src/modules/landing-page/routes.ts:35`.

### Phase 7 — SaaS marketing page rebuild

**Files:** `apps/chrono-web/src/app/(saas-landing)/page.tsx`,
`apps/chrono-web/src/components/landing/marketing-header.tsx` (new),
`marketing-footer.tsx` (new)

**Tasks**
1. Reduce `page.tsx`'s apex branch to a **thin composition** — resolve sections from the
   registry and map over them. The 964-line monolith and its 11 const arrays are deleted,
   their copy having moved to `content/saas.ts` in Phase 5.
2. Build the header on the extended `SiteHeader` with `transparentUntilScroll`, the owl +
   `font-chrono` "CHRONO" wordmark (`premium-text-gradient`) + "BY IZUR" lockup, the nav
   set, and the gold pill CTA (`rounded-full`, semantic `bg-primary`, **not** the
   reference's `bg-gold` literal).
3. Build the footer on the extended `SiteFooter` with the Platform / Company / Location
   columns, the `premium-dots` overlay, and the bottom bar.
4. Keep the existing tenant-host branch working until Phase 8 replaces it.

**Acceptance:** apex landing visually matches the reference; header is transparent at top
and solidifies past 8px; mobile menu works; `page.tsx` is a composition file, not a
monolith.

**Verify:** `pnpm typecheck`; browser pass at `localhost:3000` in light **and** dark.
**Start:** `apps/chrono-web/src/app/(saas-landing)/page.tsx:84`.

### Phase 8 — Tenant landing page rebuild

**Files:** `apps/chrono-web/src/app/(saas-landing)/about/page.tsx`,
`apps/chrono-web/src/app/(saas-landing)/page.tsx` (tenant branch),
`apps/chrono-web/src/lib/landing-config.ts`

**Tasks**
1. Rebuild `/about` — the real tenant landing — as a registry-driven composition using the
   shared header/footer, **fixing its existing raw-`div`/`main` violation**. Tenant
   branding (`logoUrl`/`logoDarkUrl`/`displayName`/`tagline`) drives the lockup via the
   existing `BrandHeader`; the owl is the SaaS default only, never a branded tenant's mark.
2. Add a `cache()`d resolver feeding both `generateMetadata` and the page (the reference's
   good pattern) for per-tenant title/favicon/OG.
3. Point the tenant branch of `page.tsx` at the same resolved config instead of its
   current hardcoded `tenantHighlights`, so the tenant surface finally reads
   `/public/landing-page` (today it doesn't).
4. Honour `hidePlatformBranding`/`platformBrandingLabel` in the tenant footer — the
   reference stores these and ignores them.

**Acceptance:** a configured tenant's `/about` shows their content, logo, theme, and only
their enabled sections in their order; an unpublished tenant shows the default/empty
state; no cross-tenant leakage.

**Verify:** `pnpm typecheck`; browser pass on two seeded tenant hosts.
**Start:** `apps/chrono-web/src/app/(saas-landing)/about/page.tsx:74`.

### Phase 9 — Dashboard editor

**Files:** `apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/landing-page/page.tsx`

**Tasks**
1. Extend the existing editor (do **not** rebuild it, and do not let it become the
   reference's 815-line single file — split into `content-editor`, `sections-editor`,
   `theme-picker` components under `components/dashboard/landing/`).
2. **Theme picker**: swatch `Button`s per preset, each showing its own `primary` color
   (`Select` exists in `agora/ui` and was considered — swatches win here because a color
   choice should show the color).
3. **Sections editor**: list registry sections for `surface: "tenant" | "both"` with a
   visibility toggle (`Switch`) and up/down reordering, persisting to `sections`.
4. **Publish toggle** for `isPublished`, with copy making the draft/live distinction plain.
5. Everything stays inside the existing
   `<Can permissions={permissions} resource="landingPage" action="manage">` gate.

**Acceptance:** an owner can change theme, toggle/reorder sections, edit content, and
publish; a `staff` member sees no editor and a direct PATCH 403s; each sub-editor file
stays well under 300 lines.

**Verify:** `pnpm typecheck`; manual dashboard pass.
**Start:** `apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/landing-page/page.tsx:55`.

### Phase 10 — E2E (mandatory)

**Files:** `apps/chrono-web/e2e/tests/tenant-landing/{edit-role-gate,public-page}.spec.ts`,
`apps/chrono-web/e2e/tests/tenant-landing/landing-customization.spec.ts` (new)

**Tasks**
1. Extend the two existing specs (reuse their `signUp`/`findInviteLink` helpers) and add
   one new spec covering the customization surface.
2. Required three cases, per `.ai/rules/e2e-testing.md`:
   - **Happy path** — owner sets theme + hides a section + edits hero copy + publishes;
     `/about` reflects all of it (assert the computed `--primary` and the presence/absence
     of section `data-testid`s).
   - **Role gate** — `staff` sees no editor; a direct
     `PATCH /rpc/landing-page {themePreset, sections, config}` 403s.
   - **Cross-tenant isolation** — tenant A's config, theme, and section layout never
     appear on tenant B's `/about`.
3. Also assert the **publish gate**: an unpublished tenant's `/about` shows no draft copy.

**Acceptance:** all three cases green plus the publish-gate case.

**Verify:** `pnpm dev:chrono` (**not** root `pnpm dev` — that starts the scaffold on the
same port; chrono's `playwright.config.ts` declares no `webServer`), teeing output to
`DEV_LOG_PATH` (default `/tmp/agora-dev.log`) since `findInviteLink()` reads it. Then the
`tenant-landing` specs, then the full `apps/chrono-web` suite.
**Start:** `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts:1`.

### Phase 11 — Docs

**Files:** `apps/chrono-api/AGENTS.md`

**Tasks**
1. Add a `## Landing pages` section documenting: the registry (how to add a section — one
   entry, no page edits), the config/sections/theme storage shape, the publish gate, the
   `/public/*` routes and their limiters, and the theme-preset contribution rules
   (including the WCAG-AA check every new palette must pass).
2. **Correct the stale source path** — record that the oikos reference lives at
   `/Users/risurina/karta/karta-tenant`, not the unreachable Windows path currently named.
3. Document the **promotion path**: if a second business app needs configurable landing
   pages, the resolver + registry shape moves to `packages/agora` unchanged, with only the
   section vocabulary staying app-owned. Note the deferred **content/industry presets**
   seam (the reference's `landing-presets.ts` idea) as the next extension.

**Acceptance:** the section matches what shipped; the stale path is corrected.
**Start:** `apps/chrono-api/AGENTS.md`, after "Unauthenticated routes".

## Verification (whole plan)

1. `pnpm typecheck` after every phase (Turborepo covers all packages).
2. `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅` after Phase 3.
3. Browser pass in **light and dark**, desktop and mobile width, after Phases 7 and 8 —
   no console errors, header scroll behaviour correct, no horizontal scroll.
4. Full `apps/chrono-web` e2e suite green after Phase 10.
5. `pnpm build` before hand-off.

## Out of scope

- `apps/agora-web` and the `apps/agora-api` scaffold (Phase 1 touches only shared
  `agora/ui` primitives, additively and backward-compatibly).
- Content/industry presets, a live-preview pane, and per-section custom CSS — documented
  as future seams in Phase 11.
- The `theme-elite` alternate palette, `.premium-glow-cyan/-violet`, `.glass-panel`.
- Dropping or migrating the six legacy flat content columns.
- Any new permission resource — `landingPage:manage` already covers this surface.
