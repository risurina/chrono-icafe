# Chrono: landing-page rebuild on the foundation landing capability

## Context

Rebuild `apps/chrono-web`'s **SaaS marketing landing page** and **per-tenant public
landing page** to closely match the karta-oikos/chrono design, and make them fully
tenant-customizable (content, theme, branding, which sections appear and in what order).

Three standing developer directives shape every decision: *"just improve it"*, *"make it
best practise coding"*, *"make sure easy to customize in future project"* — matching this
repo's own rule that oikos is **prior art, not a spec**
(`apps/chrono-api/AGENTS.md`). Match the visual result; write the implementation fresh.

**Depends on:** `.ai/plans/agora/active/tenant-landing-foundation/README.md`, which lands
first and provides the primitives, contracts, registry builder, resolvers, theme-preset
mechanism, `tenant_landing_page` storage, and route factory. This plan supplies only
Chrono's **vocabulary and appearance**. Do not rebuild any of that machinery here.

**Supersedes:** `.ai/plans/chrono/archive/chrono-landing-theme-presets/` — its palette
values and cascade rationale are carried into Phase 2 and Phase 6 below.

**Reference source (read directly):** `/Users/risurina/karta/karta-tenant/apps/chrono-web`
(+ `chrono-api`, `packages/oikos`). This corrects `apps/chrono-api/AGENTS.md`, which names
an unreachable Windows path — fixed in Phase 8.

### Keep from the reference

Thin page + one component per section; the `react.cache()`d host resolver feeding both
`generateMetadata` and the page; the publish gate; `color-mix(… var(--primary) …)`
"premium" utilities (one token re-skins every glow/gradient/dot — the re-skin lever);
`data-testid` discipline.

### Do NOT port

Three near-identical headers and three near-identical footers with zero sharing; content
hardcoded in JSX at ~250 lines/section (and an 815-line settings editor); a large
dead-code surface (an unreachable `saas/` variant, 9 orphaned sections, a lorem `[slug]`
stub); hardcoded colors bypassing their own tokens (`bg-[#080806]`, `amber-500`,
`rgba(26,26,28,.6)` inside `.glass-panel`); raw HTML filling imported primitives; `any`-typed
merge logic; **stored-but-never-applied `primaryColor`/`accentColor`**; no section
model at all; a dead mobile hamburger; a render-blocking font `@import` plus an
`!important` `.font-chrono`.

### Where we start

- `(saas-landing)/page.tsx` — a **964-line monolith**, ~11 hardcoded const arrays, apex
  branch `:84-783`, tenant branch `:785-963`. The tenant branch **never reads**
  `/public/landing-page`.
- `(saas-landing)/about/page.tsx` — the real tenant landing — raw `div`/`main` at `:74`,
  **no `SiteHeader`/`SiteFooter`**: an existing `component-first-ui` violation to fix.
- `ChronoLandingPages` — six live content columns, no sections/theme/publish.

## Phase 1 — Brand system

**Files:** `apps/chrono-web/src/app/layout.tsx`, `apps/chrono-web/src/app/globals.css`,
`apps/chrono-web/public/brand/` (new)

**Tasks**
1. Load **Bruno Ace SC** via `next/font/google` — `Bruno_Ace_SC({ weight: "400", subsets:
   ["latin"], display: "swap", variable: "--font-chrono-display" })`. **Not** a CSS
   `@import` (the reference's is render-blocking and unhoisted).
2. Map it in `globals.css`'s `@theme inline`: `--font-chrono: var(--font-chrono-display);`.
   The distinct names matter — mapping `--font-chrono: var(--font-chrono)` is a
   self-reference. This follows the block's existing `--color-primary: var(--primary)`
   pattern. Note `@theme inline` (`globals.css:88-130`) currently has **no font key** at
   all; `font-sans` works only because Tailwind v4 ships a `--font-sans` default that
   Inter's variable shadows on `<body>`. Bruno Ace SC has no such default. **No
   `!important`**, and no separate `.font-chrono` rule duplicating the token.
3. Port the `.premium-*` utilities into `@layer utilities`, token-only:
   `.premium-text-gradient`, `.premium-gradient`, `.premium-glow`, `.premium-card-shadow`,
   `.premium-grid`, `.premium-dots`, `.glass-card`. Keep the solid `var(--primary)` fallback
   line before each `color-mix()` line. **Drop** `.premium-glow-cyan`/`-violet` and
   `.glass-panel` — they hardcode `rgba()` literals and belong to the unused `theme-elite`.
4. Copy the owl to `apps/chrono-web/public/brand/chrono-owl.png` from the reference's
   `public/favicon/apple-icon-180x180.png` (largest clean source; **no SVG exists** in the
   reference or on the live site). Render via `next/image`, not a raw `<img>`.

**Acceptance:** `font-chrono` renders Bruno Ace SC with no `!important` and no layout shift;
each `.premium-*` visibly responds to a `--primary` change; no hardcoded hex outside the
`:root`/`.dark` token blocks.

**Verify:** `pnpm --filter @agora/chrono-web typecheck`.
**Out of scope:** the `theme-elite` palette; any section component.
**Start:** `apps/chrono-web/src/app/layout.tsx:2`.

## Phase 2 — Chrono's theme palettes

**Files:** `apps/chrono-web/src/lib/theme-presets.ts` (new)

**Tasks**
1. Register `elegant-gold` and `neon-green` via the foundation's
   `buildThemePresetRegistry()`. **Palette values are already audited — copy them, do not
   re-derive:** `elegant-gold` is the currently-shipped `globals.css` `:root` (decls
   **16-47**) and `.dark` (decls **53-83**), *including all `sidebar-*` keys and the
   manually-edited `--card: #080806`*; `neon-green`'s AA-corrected values are in
   `.ai/plans/chrono/archive/chrono-landing-theme-presets/README.md`, Phase 2 task 4
   (note its light `--ring`/`--chart-1` use `#0f7a3d`, **not** `#22c55e`, which fails the
   3:1 non-text floor).
2. `elegant-gold` is the default; `globals.css` keeps its hardcoded blocks as the
   pre-resolve fallback, so `themePresetCss()` returns `""` for the default case.
3. Every new palette must clear WCAG AA (4.5:1 text, 3:1 non-text) before merging —
   methodology in `.ai/plans/chrono/archive/chrono-theme-colors/palette-source.md`.

**Acceptance:** both palettes registered; switching to `neon-green` re-skins every
`.premium-*`; a documented AA check exists for each.

**Verify:** `pnpm --filter @agora/chrono-web typecheck`.
**Out of scope:** the preset *mechanism* (foundation Phase 3).
**Start:** `apps/chrono-web/src/lib/theme-presets.ts` (new file).

## Phase 3 — Chrono storage decision + migration

**Files:** `apps/chrono-api/src/modules/landing-page/schema.ts`, migration

**Decision (must be explicit — `ChronoLandingPages` has live rows):** the foundation's
`tenant_landing_page` becomes the source of truth for `config`/`sections`/`themePreset`/
`isPublished`. `ChronoLandingPages` **survives** as a chrono-only extension for
chrono-specific fields, and its six existing content columns are **migrated into the
foundation row's `config`** by a one-time data migration, then left in place (read-only,
unread) rather than dropped — dropping them is a separate cleanup once the new path is
proven in production.

**Tasks**
1. Data migration: for every `ChronoLandingPages` row, upsert a `tenant_landing_page` row
   with `config` built from `heroTagline`/`aboutBody`/`amenitiesBody`/`contactOverride`/
   `ctaLabel`/`ctaHref`.
2. **Backfill `isPublished = true`, `publishedAt = updatedAt` for every migrated row.**
   Without this, the publish gate takes every already-configured tenant's live page dark on
   deploy, with no action on their part.
3. `pnpm --filter @agora/chrono-api db:generate --name chrono_landing_page_migrate_to_foundation`
   then `pnpm --filter @agora/chrono-api db:migrate`. **Root `db:*` scripts target the
   scaffold `@agora/api`** (`package.json:18-19`) — the `--filter` is required. Never
   `db:push`.

**Acceptance:** every existing chrono tenant's landing content is readable from the
foundation row and their page stays **live** (not silently unpublished) after deploy.

**Verify:** `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅` (chrono's own
proof, not `@agora/api`'s); spot-check a migrated row.
**Out of scope:** dropping the legacy columns.
**Start:** `apps/chrono-api/src/modules/landing-page/schema.ts:13`.

## Phase 4 — Chrono section registry + content modules

**Files:** `apps/chrono-web/src/components/landing/registry.ts` (new),
`content/saas.ts` (new), `apps/chrono-web/src/lib/landing-config.ts` (new)

**Tasks**
1. Register chrono's section keys through the foundation's
   `buildLandingSectionRegistry()`, each entry supplying `propsFrom()` so
   `renderSection(def, resolved)` type-checks. Keys are plain strings (foundation rule) —
   `apps/chrono-api` and `apps/chrono-web` cannot import each other
   (`.ai/rules/monorepo.md`), so the vocabulary lives web-side and the API validates keys
   as `z.string()` + sanitize-on-read, exactly as the foundation specifies.
2. Extend the foundation's `landingConfigSchema` with chrono's own blocks (`amenities`,
   `rates`, `stationSpecs`) via `.extend()`, re-exporting `ctaHrefSchema` from the
   foundation rather than keeping the local copy.
3. Move all SaaS copy out of JSX into `content/saas.ts` as typed consts. The reference wrote
   this abstraction (`saas/Content.ts`) and then abandoned it — we use it.

**Acceptance:** registry entries are self-contained and type-safe end to end; no section file
contains literal marketing copy.

**Verify:** `pnpm --filter @agora/chrono-api typecheck`; foundation resolver tests already
cover order/hide/unknown-key behaviour — no duplicate test here.
**Out of scope:** the resolver/registry machinery (foundation Phase 2).
**Start:** `apps/chrono-web/src/components/landing/registry.ts` (new file).

## Phase 5a — SaaS section components

**Files:** `apps/chrono-web/src/components/landing/sections/*.tsx` (new)

**Tasks**
1. The 15 SaaS sections: hero, dashboard preview, positioning strip, problems, solution,
   modules, roles, comparison, how-it-works, benefits, showcase, mobile preview, pricing,
   FAQ, final CTA. One file each, one typed props object each.
2. Composed **only** from `agora/ui` primitives (`Section`, `Grid`, `Stack`, `Card*`,
   `StatTile`, `FaqItem`, `SectionHeading`, `Table*`, `Badge`, `Button`) — no raw
   `div`/`span`/`ul` chrome, the reference's biggest violation. `data-testid` on every
   section root.
3. **If a section needs a primitive that does not exist, add it to
   `packages/agora/src/presentation/ui/components/` and export it from `index.ts` before
   writing the section** (`.ai/rules/component-first-ui.md`) — do not invent a local wrapper.

**Acceptance:** every section renders from props alone; zero raw HTML chrome outside
`packages/agora`.

**Verify:** `pnpm typecheck`.
**Out of scope:** tenant sections; page assembly.
**Start:** `apps/chrono-web/src/components/landing/sections/hero.tsx` (new file).

## Phase 5b — Tenant section components

**Files:** `apps/chrono-web/src/components/landing/sections/tenant-*.tsx` (new)

**Tasks** — same rules as 5a for: hero, station availability, rates, specs, about,
amenities, location/branches, FAQ, final CTA.

**Acceptance / Verify:** as 5a.
**Out of scope:** SaaS sections; page assembly.
**Start:** `apps/chrono-web/src/components/landing/sections/tenant-hero.tsx` (new file).

## Phase 6 — Routes

**Files:** `apps/chrono-api/src/modules/landing-page/routes.ts`, `apps/chrono-api/src/app.ts`

**Tasks**
1. Mount the foundation's `landingRoutes()` and `createPublicLandingRoute()`. Keep chrono's
   existing `/rpc/landing-page` working during transition, reading through to the
   foundation row.
2. Mount chrono's theme-preset public route with its **own** rate-limit bucket (not
   `landingPageIpLimiter`, which bounds the heavier content read and would contend with
   dashboard renders), recording **before** the DB work.
3. Keep `/public/landing-page`'s `branches` + `hasStations` reachable. **Stated decision:**
   these remain visible for an *unpublished* tenant — they are already-public venue facts
   surfaced by `/stations`, and the publish gate covers *authored content* only.

**Acceptance:** a `staff` PATCH 403s; an unpublished tenant returns null content but still
resolves branches; tenant A's config never appears for tenant B.

**Verify:** `pnpm typecheck`; `curl` both public routes on two tenant hosts.
**Out of scope:** the route factory itself (foundation Phase 5).
**Start:** `apps/chrono-api/src/app.ts:583`.

## Phase 7a — SaaS page rebuild

**Files:** `apps/chrono-web/src/app/(saas-landing)/page.tsx`,
`apps/chrono-web/src/components/landing/marketing-header.tsx`, `marketing-footer.tsx` (new)

**Tasks**
1. Reduce the apex branch to a **thin composition** mapping over resolved sections. The
   964-line monolith and its 11 const arrays go.
2. Header on the foundation's `SiteHeader` with `transparentUntilScroll` + `mobileNav`: owl +
   `font-chrono` "CHRONO" (`premium-text-gradient`) + "BY IZUR" lockup, the nav set, and a
   gold pill CTA using semantic `bg-primary` (**not** the reference's `bg-gold` literal).
3. Footer on the foundation's `SiteFooter` with Platform / Company / Location columns, the
   `premium-dots` overlay, and the bottom bar.

**Acceptance (checkable, not "looks right"):** `page.tsx` is a composition file under ~120
lines; header is transparent at scrollY 0 and solid past 8px; the mobile drawer opens and
lists every nav item; all 15 section `data-testid`s present; no console errors; no
horizontal scroll at 375px; renders in light **and** dark.

**Verify:** `pnpm typecheck`; browser pass at `localhost:3000`, desktop + 375px, both themes.
**Out of scope:** the tenant branch (7b).
**Start:** `apps/chrono-web/src/app/(saas-landing)/page.tsx:84`.

## Phase 7b — Tenant page rebuild

**Files:** `apps/chrono-web/src/app/(saas-landing)/about/page.tsx`,
`(saas-landing)/page.tsx` (tenant branch)

**Tasks**
1. Rebuild `/about` as a registry-driven composition on the shared header/footer, **fixing
   its raw-`div`/`main` violation**. Tenant branding drives the lockup via the existing
   `BrandHeader`; the owl is the SaaS default only, never a branded tenant's mark.
2. Add a `cache()`d resolver feeding both `generateMetadata` and the page (per-tenant
   title/favicon/OG) — the reference's good pattern.
3. Point the tenant branch of `page.tsx` at the same resolved config instead of its hardcoded
   `tenantHighlights`, so the tenant surface finally reads its own landing content.
4. Honour `hidePlatformBranding`/`platformBrandingLabel` in the tenant footer — the reference
   stores these and ignores them.

**Acceptance:** a configured tenant sees their content, logo, theme, and only their enabled
sections in their order; an unpublished tenant sees the default state; no cross-tenant leak.

**Verify:** `pnpm typecheck`; browser pass on two seeded tenant hosts, both themes.
**Out of scope:** the editor (Phase 8).
**Start:** `apps/chrono-web/src/app/(saas-landing)/about/page.tsx:74`.

## Phase 8 — Dashboard editor

**Files:** `apps/chrono-web/src/app/(tenant-admin)/dashboard/settings/landing-page/page.tsx`,
`apps/chrono-web/src/components/dashboard/landing/*` (new)

**Tasks**
1. Extend the existing editor; **split** into `content-editor`, `sections-editor`,
   `theme-picker` (each well under 300 lines — the reference's equivalent is 815 in one file).
2. **Theme picker**: swatch `Button`s showing each preset's actual `primary`. (`Select`
   exists in `agora/ui` and was considered — swatches win because a color choice should show
   the color.)
3. **Sections editor**: registry sections for `surface: "tenant" | "both"`, with a `Switch`
   per section and up/down reordering, persisting to `sections`.
4. **Publish toggle** with copy making draft-vs-live plain.
5. **Load-bearing strings — do not change:** the toast text `"Landing page updated."`
   (`page.tsx:105`) and the `Label`s `"Hero tagline"` / `"About"` / `"Amenities"`
   (`:125`/`:133`/`:142`). Two existing e2e specs query them.
6. All of it stays inside the existing
   `<Can permissions={permissions} resource="landingPage" action="manage">` gate.

**CRUD / feedback contract:** config blocks are upsert-only (**no delete**; reset = clear
the block; no soft-delete in MVP). Publish/unpublish is reversible; unpublishing **retains**
`publishedAt` as the last-published marker. Every mutation fires a toast. Publish/unpublish
is audit-logged.

**Acceptance:** an owner can edit content, pick a theme, toggle/reorder sections, and publish;
`staff` sees no editor and a direct PATCH 403s; every sub-editor file is under 300 lines.

**Verify:** `pnpm typecheck`; manual dashboard pass.
**Out of scope:** a live-preview pane.
**Start:** `.../dashboard/settings/landing-page/page.tsx:55`.

## Phase 9 — E2E (mandatory)

**Files:** `apps/chrono-web/e2e/tests/tenant-landing/{edit-role-gate,public-page}.spec.ts`,
`landing-customization.spec.ts` (new)

**Tasks**
1. **Fix the three existing assertions the publish gate breaks.** `public-page.spec.ts`'s
   `saveLandingPage()` happy path and isolation test, and `edit-role-gate.spec.ts:122`, all
   save content and then assert it on `/about`. With the gate, saving is no longer
   sufficient — each must toggle Publish first.
2. New spec covering the three mandatory cases:
   - **Happy path** — owner sets theme + hides a section + edits hero copy + publishes;
     `/about` reflects all of it (assert computed `--primary` and section `data-testid`
     presence/absence).
   - **Role gate** — `staff` sees no editor; a direct
     `PATCH /rpc/landing-page {themePreset, sections, config}` 403s.
   - **Cross-tenant isolation** — tenant A's config, theme, and layout never appear on
     tenant B's `/about`. *This is the only real proof for the `withAdmin` read path;
     `rls:proof` does not cover it.*
   - Plus the **publish gate**: an unpublished tenant's `/about` shows no draft copy.

**Acceptance:** all four cases green, and the three pre-existing assertions pass again.

**Verify:** `pnpm dev:chrono` (**not** root `pnpm dev` — that starts the scaffold on the same
port; chrono's `playwright.config.ts` declares no `webServer`), teeing output to
`DEV_LOG_PATH` (default `/tmp/agora-dev.log`) since `findInviteLink()` reads it. Then the
`tenant-landing` specs, then the full `apps/chrono-web` suite.
**Out of scope:** scaffold specs (foundation Phase 7).
**Start:** `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts:1`.

## Phase 10 — Docs

**Files:** `apps/chrono-api/AGENTS.md`

**Tasks**
1. Add a `## Landing pages` section: how to add a section (one registry entry, no page
   edits), the config/sections/theme storage shape, the publish gate, the public routes and
   their limiters, and the WCAG-AA rule for any new palette.
2. **Correct the stale source path** — the oikos reference is at
   `/Users/risurina/karta/karta-tenant`, not the unreachable Windows path currently named.
3. Carry over the archived theme-presets plan's **reserved extension point**: a future
   custom color picker layers *on top of* presets exactly as `TenantBrandings.primaryColor`
   already layers over the preset — preset CSS first, branding CSS second and winning.
   `disableTransitionOnChange` is explicitly **not** the mechanism.

**Acceptance:** the section matches what shipped; the stale path is corrected; the extension
note survives the plan merge.

**Verify:** read-through against merged code (docs-only).
**Out of scope:** foundation docs (foundation Phase 8).
**Start:** `apps/chrono-api/AGENTS.md`, after "Unauthenticated routes".

## Verification (whole plan)

1. `pnpm typecheck` after every phase.
2. `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅` after Phase 3.
3. Browser pass in light **and** dark, desktop and 375px, after Phases 7a and 7b.
4. Full `apps/chrono-web` e2e suite green after Phase 9.
5. `pnpm build` before hand-off.

## Out of scope (whole plan)

- Everything in the foundation plan (primitives, contracts, registry builder, resolvers,
  preset mechanism, `tenant_landing_page`, route factory, scaffold surface).
- Dropping `ChronoLandingPages`' six legacy columns (a later cleanup once proven).
- Content/industry presets, a live-preview pane, a draft-preview URL, per-section custom CSS.
- The `theme-elite` palette, `.premium-glow-cyan/-violet`, `.glass-panel`.
- Any new permission resource — `landingPage:manage` already covers this surface.
