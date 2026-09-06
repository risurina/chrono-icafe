# Chrono email theming: wire the tenant's theme preset + brand asset into its emails

Status: Draft
Owner: Chrono's email call sites (`apps/chrono-api`)

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]
- Audit (1st pass): plan-auditor subagent (ae51a9e4338840971) — NEEDS
  REVISION. 2 BLOCKERs (a third `renderBrandedEmail` call site,
  `apps/chrono-api/src/routes/rpc.ts`'s `POST /rpc/integrations/email/test`,
  was never listed; the owl-logo URL used an `http://` scheme in
  non-production, which the renderer's `https://`-only guard silently drops,
  making Phase 3's own acceptance criterion unachievable as written) + 6
  CONDITION/RISK findings (the "preset only affects `/about`" claim was
  factually wrong — it skins the tenant's whole surface via the root layout;
  Chrono's palette tokens include 8-digit-alpha and 3-digit hex the renderer's
  6-digit guard would silently drop; the relocated file's path didn't match
  this repo's own extension-seam convention; Phase 1 didn't verify the
  existing theme-preset e2e coverage; a hardcoded `displayName: "Chrono"`
  would silently override the deployed `APP_NAME`; a new client-bundle value
  import from `chrono-api` wasn't checked against `next.config.ts`'s
  `transpilePackages`) — all resolved in that revision.
- Audit (2nd pass, after `email-design-system` landed): plan-auditor subagent
  (a3f2cecd9aad64adb) — NEEDS REVISION. All 1st-round claims re-verified
  correct against the now-landed foundation API. 1 new BLOCKER (a **fourth**
  `renderBrandedEmail` call site, `apps/chrono-api/src/modules/business-lead/
  routes.ts:125`'s `notifyBusinessLeadSubmitted`, was still missing — same
  "IZUR-internal, unbranded, same inbox" class as `company-inquiry`, per that
  file's own comment "the same inbox and email path
  `modules/company-inquiry/public-routes.ts` uses") + 1 CONDITION (the owl-
  logo URL was still an unconfirmed placeholder with no evidence it was the
  real production host). Both resolved below: developer confirmed
  `https://chrono.izur.com.ph/brand/chrono-owl.png` is the real, live, always-
  https production host serving this asset, and confirmed `business-lead`'s
  notification should get the identical owl-logo treatment as
  `company-inquiry`. Phase 3 updated accordingly.
- Implementation: (this session) implementing via Jules, per developer's "use
  jules for now" instruction; no schema/RLS/tenant-isolation/permission-gate
  design in any phase, all 4 phases Jules-eligible.

## Depends on

**Landed.** `.ai/plans/agora/archive/email-design-system/README.md` is fully
implemented and archived on `main` (commits `634b3703`, `6c2192b6`,
`797d5bc2`, `04f577f6`, plus fix-review `44e9f50e`/`e880d2ff`/`8896614c`) —
`registerEmailThemeResolver`/`EmailThemeTokens`/`resolveTenantEmailTheme`/
`DEFAULT_EMAIL_THEME`/`EmailTheme`/`EmailThemeResolver` all resolve from
`agora/server`. This plan is now unblocked and may proceed.

Note when implementing Phase 2 (registering Chrono's own resolver): the
foundation's `resolveTenantEmailTheme` validates every resolver-supplied
token field against `/^#[0-9a-fA-F]{6}$/i` and silently drops an invalid one
(falls back to the current value) rather than throwing — so Chrono's own
resolver implementation should return well-formed 6-digit hex strings for
every token it supplies, or the corresponding default will silently apply
instead.

## Why this plan exists

The developer asked to "extend agora and use chrono theming" for email. The
foundation plan builds the generic mechanism (a resolved theme + dark mode +
component builders); this plan supplies Chrono's specific data: its theme-preset
palette (`elegant-gold` / `neon-green`, `apps/chrono-web/src/lib/theme-presets.ts`),
registered once at boot, plus migrating Chrono's own ad hoc email call sites
onto the new component builders. Per `.ai/rules/business-app.md`, Chrono's
palette data is business-specific and does not belong in `packages/agora` — it
belongs here, wired in through the seam.

**The developer also noted**: "we have logos in assets" — referring to
`apps/chrono-web/public/brand/chrono-owl.png` (and `mascot.png`). Read in
context, this only applies to ONE of Chrono's email flows (see Phase 3) —
`apps/chrono-api/AGENTS.md`'s "brand lockup" section is explicit that **the owl
is the marketing default only, and must never appear on a tenant-branded
surface** ("A tenant with a logo gets it through `BrandHeader`; never hardcode
the owl on a branded tenant's page"). Every *tenant-facing* Chrono email
(member invite, member approval/rejection) keeps using the tenant's own
`emailLogoUrl`/`logoUrl` with a plain brand-name-text fallback, unchanged — no
owl. The owl is used only for Chrono/IZUR's own **internal**, unbranded
notification email (the company-inquiry inbox notification, sent to
`SUPPORT_INBOX_EMAIL` — verified in code: `company-inquiry/public-routes.ts:99`
sends `to: inboxEmail` with `replyTo: <the inquirer's own address>`, so the
inquirer never receives this message, only a reply to it — Chrono's own team,
never a tenant's customer), where it is genuinely Chrono's own identity, not a
stand-in for a tenant's.

## Pass 1 — Workflow Analysis

**Who is affected**: a tenant's portal customers (members) receiving an
invite/approval/rejection email now see their tenant's actual published theme
(card background, button color, borders) instead of a generic white-card
layout with only the tenant's raw `primaryColor` as an accent. Chrono's own
staff, reading the internal inquiry-notification inbox, sees IZUR's brand mark
instead of a bare "New inquiry" subject with no visual identity.

**Current behavior, verified in code**:
- `apps/chrono-web/src/lib/theme-presets.ts` defines `CHRONO_THEME_PRESETS`
  (`elegant-gold` default, `neon-green`) via the foundation's
  `buildThemePresetRegistry`. A tenant picks one on
  `/dashboard/settings/landing-page` (`ThemePicker`), stored as
  `themePreset` on that tenant's **landing page** draft/published snapshot
  (`TenantLandingPages`, `packages/agora/src/core/contracts/landing.ts:374`,
  persisted in `tenantLandingPage.draft`/`published` jsonb —
  `packages/agora/src/core/db/schema/tenant.ts:723-737` — **not**
  `tenantBranding`, which carries `logoDarkUrl`/`emailLogoUrl` and no theme
  key at all).
- **This is not a page-scoped setting** — `apps/chrono-web/src/app/layout.tsx:66`
  applies `themePresetCss(CHRONO_THEME_PRESETS, landing?.themePreset)` inside
  the **root** layout (`layout.tsx:54`), which wraps every route on a tenant
  host: `/about`, `/member/*`, the `/admin/*` dashboard rewrite, `/stations`,
  `/portal/*`. The landing-page `themePreset` is already the tenant's
  **whole-surface** theme, not an `/about`-page-only setting — email
  inheriting it is the consistent choice, not a stretch. Both readers (the web
  app's `apps/chrono-web/src/lib/landing.ts:117-126` and the foundation's
  `readPublishedLandingPage`, `packages/agora/src/core/server/routes/landing.ts:191-195`)
  use the **published** snapshot only, so email and the web surface can never
  disagree, and a draft-only preset change correctly affects neither.
- This file lives in `apps/chrono-web` — a **browser** app. Email is sent from
  `apps/chrono-api` (server). `chrono-api` cannot import from `chrono-web`
  (verified: `apps/chrono-api/package.json` has no dependency on
  `chrono-web`; the dependency direction is `chrono-web → chrono-api`, via
  `apps/chrono-web/package.json`'s `"@agora/chrono-api": "workspace:*"` and its
  existing subpath `exports` map that `chrono-web` already imports type/value
  content from — see Phase 1). There is no other shared location for this
  data: `packages/agora` is business-domain-neutral and must not carry
  Chrono's palette (`.ai/rules/business-app.md`), so relocating it into
  `chrono-api` is the only correct direction.
- Every Chrono-owned email call site builds its own ad hoc `EmailBranding`
  object with no theme and no `logoDarkUrl`. There are **three**, not two:
  - `apps/chrono-api/src/modules/company-inquiry/public-routes.ts` — IZUR's own
    unbranded internal inbox notification (`branding` is all-`null`).
  - `apps/chrono-api/src/modules/member/routes.ts`'s `sendMemberOnboardingEmail`
    — tenant-branded (reads `tenantBranding`), backs the approve/reject-decision
    emails (`notifyMemberOfDecision`).
  - `apps/chrono-api/src/routes/rpc.ts`'s `POST /rpc/integrations/email/test`
    (Chrono's own copy of the scaffold's identical route) — tenant-branded,
    already a full `.select()` so `b.logoDarkUrl` is available with no
    projection change.
- Chrono's portal member invite/reset emails are NOT a Chrono call site —
  they go through the foundation's `agora/member-auth` (`inviteTenantMember`,
  imported by `member/routes.ts`). Traced end to end:
  `member/routes.ts:353` destructures `tenantId` from `c.var.tenant`,
  passes it to `inviteTenantMember`, which calls `sendMemberEmail(tenantId,
  …)` inside `packages/agora/src/identity/member-auth/index.ts`; the reset
  route calls `sendMemberEmail(org.id, …)` the same way. Both reach the
  foundation's single shared helper with a real `tenantId`. Per the
  foundation plan's Phase 3, that helper already resolves the registered
  theme internally — **once this plan's Phase 2 registers Chrono's resolver,
  those two flows are covered automatically, with zero Chrono-side code
  change.** (Confirmed correct by the audit — not just asserted.)

**Failure cases**:
- A tenant with no published landing page (never configured one) or one
  published with an unrecognized/legacy `themePreset` value → resolves to
  `CHRONO_THEME_PRESETS.defaultKey` (`"elegant-gold"`), never a crash or a
  blank/unstyled email — mirrors `themePresetCss()`'s own "unknown key emits
  nothing, falls through to the default" behavior.
- The `readPublishedLandingPage` read fails (DB blip) → `resolveChronoEmailTheme`
  returns `null`, which the foundation's `resolveTenantEmailTheme` treats as "no
  override," falling back to `DEFAULT_EMAIL_THEME` — fail-open, logged, email
  still sends. A themed email is a nice-to-have, not a delivery-blocking
  dependency.
- A tenant's own `primaryColor`/`accentColor` override still beats the preset
  (Phase 2), matching the existing `brandingCss()` precedent tenants already
  rely on for their landing page.
- Chrono's palette hex values are not all email-safe as stored (see Phase 2) —
  handled by an explicit normalization step, not left to the renderer to
  silently drop.

**No new admin UI, no new route, no schema change** — this is exclusively a
"which colors does an existing email use" change.

## Pass 2 — Technical Planning

**Boundary**: `apps/chrono-api` (new file + 4 edits — one more than originally
scoped, see the `rpc.ts` fix below), `apps/chrono-web` (1 file reduced to a
re-export, 1 config file), `apps/chrono-api/package.json` (1 new export). No
`packages/agora` changes (that's the dependency, already landed). No schema
change, no RLS impact — `rls:proof` not applicable.

### Chrono's `EmailThemeTokens` mapping — and why it needs normalization

`CHRONO_THEME_PRESETS`'s palettes use key names that map almost 1:1 onto the
foundation's `EmailThemeTokens` (deliberately named to match, per the
foundation plan):

| `ThemePresetDefinition.light`/`.dark` key | `EmailThemeTokens` field |
|---|---|
| `background` | `background` |
| `card` | `card` |
| `foreground` | `foreground` |
| `muted-foreground` | `mutedForeground` |
| `border` | `border` |
| `primary` | `primary` |
| `primary-foreground` | `primaryForeground` |

But the stored **values** are not all in the 6-digit-hex form the foundation's
color guard accepts (`/^#[0-9a-fA-F]{6}$/`, `render.ts`): `border`/`input` are
8-digit hex with an alpha channel (e.g. `"#b8860b26"`,
`apps/chrono-web/src/lib/theme-presets.ts:41-42`; `"#22c55e26"`, `:119-120`),
and `card` is 3-digit shorthand (`"#fff"`, `:28`, `:106`). Passed through
unvalidated, the foundation's guard would silently drop exactly the two tokens
that carry the most visible difference between presets. `mapPresetTokens`
(Phase 2) normalizes both before they ever reach `renderBrandedEmail`.

## Out of Scope

- Any change to `packages/agora` (the foundation plan's job).
- New Chrono email flows for modules that don't send email today (`reservation`,
  `wallet`, `security-alert`, `loyalty`) — none of these send email currently
  (verified by grep across `apps/chrono-api/src/modules`); adding new
  transactional flows for them is separate, future work.
- A dark-mode-specific variant of `chrono-owl.png`.
- Moving `theme-presets.ts` changes anything about the landing-page feature
  itself — Phase 1 is a pure relocation, zero behavior change for
  `/dashboard/settings/landing-page` or the public `/about` page (or, per the
  corrected Pass 1, any other route the root layout covers).
- A caching/memoization layer for `resolveChronoEmailTheme`'s
  `readPublishedLandingPage` read — accepted as a per-send read in this pass
  (see Phase 2's note).
- Registering the resolver in `apps/chrono-api/src/seed.ts` or
  `src/e2e/run.ts` — see Phase 2's note on why this is an accepted gap, not an
  oversight.

## Phase Design

### Phase 1 — Share `CHRONO_THEME_PRESETS` with `chrono-api`

**Files to Update**
- New: `apps/chrono-api/src/contracts/theme-presets.ts` (placed next to
  `apps/chrono-api/src/contracts/extensions.ts` — the file that already holds
  Chrono's feature-flag/module registry seams per `.ai/rules/business-app.md`'s
  "Extension seams" table, which lists Theme presets as one of the five;
  a bare `src/theme-presets.ts` at the `src/` root would match no existing
  convention)
- `apps/chrono-api/package.json` (add `"./theme-presets"` to `exports`,
  pointing at the new path)
- `apps/chrono-web/src/lib/theme-presets.ts` (replace body with a re-export)
- `apps/chrono-web/next.config.ts` (add `"@agora/chrono-api"` to
  `transpilePackages`, currently `["agora"]` only at `:20`)

**Step-by-Step Tasks**
1. Move the full content of `apps/chrono-web/src/lib/theme-presets.ts`
   (the `ELEGANT_GOLD_LIGHT`/`_DARK`, `NEON_GREEN_LIGHT`/`_DARK` objects, the
   `CHRONO_THEME_PRESETS = buildThemePresetRegistry(...)` call, and
   `presetSwatch()`) verbatim into a new
   `apps/chrono-api/src/contracts/theme-presets.ts`. It only imports
   `buildThemePresetRegistry` from `agora` — already browser-safe, no
   server-only imports, so it is safe to also serve `chrono-web`'s client-side
   `ThemePicker` bundle (mirrors the existing `./station`/`./realtime` subpath
   exports, which are similarly pure leaf contract files with no DB/server
   imports).
2. Add `"./theme-presets": "./src/contracts/theme-presets.ts"` to
   `apps/chrono-api/package.json`'s `"exports"` map, alongside `./app`,
   `./realtime`, `./station`.
3. Replace `apps/chrono-web/src/lib/theme-presets.ts`'s body with:
   ```ts
   export { CHRONO_THEME_PRESETS, presetSwatch } from "@agora/chrono-api/theme-presets";
   ```
   Verified by a full-tree grep: exactly two real importers of
   `@/lib/theme-presets` exist today (`app/layout.tsx:8`,
   `components/dashboard/landing/theme-picker.tsx:6`), both importing exactly
   `CHRONO_THEME_PRESETS`/`presetSwatch` — no default export, no `import *`, no
   third importer. The shim is behavior-preserving for both.
4. Add `"@agora/chrono-api"` to `next.config.ts`'s `transpilePackages` array.
   `theme-picker.tsx` is a `"use client"` component importing
   `CHRONO_THEME_PRESETS`/`presetSwatch` as **runtime values** (not
   type-only) from another workspace app for the first time — every existing
   cross-app import from `chrono-web` is either type-only or a server-only
   value import (`lib/stations.ts`). This is new territory for the client
   bundle; adding the package name to `transpilePackages` up front avoids
   depending on Next's default module resolution happening to already handle
   it correctly.

**Acceptance Criteria**
- `apps/chrono-web/src/lib/theme-presets.ts` shrinks to a single re-export
  line (plus its file-level comment).
- `/dashboard/settings/landing-page`'s theme picker and the public `/about`
  page render identically before and after this phase (pure move, zero
  behavior change).
- `pnpm --filter @agora/chrono-api typecheck`,
  `pnpm --filter @agora/chrono-web typecheck`, **and**
  `pnpm --filter @agora/chrono-web build` (a production build is the real
  check that the new client-bundle value import resolves correctly — `tsc
  --noEmit` alone cannot catch a bundler-resolution failure) all pass.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- Manual (`pnpm dev` running, per `.ai/rules/rbac.md`'s note that this
  Playwright suite is manual): re-run
  `apps/chrono-web/e2e/tests/tenant-landing/landing-customization.spec.ts`
  (asserts the `theme-preset-neon-green` testid, posting `themePreset:
  "neon-green"`, and cross-tenant theme isolation at `:242`) and its
  neighboring `public-page.spec.ts` — both exercise the exact code this phase
  moves, and neither is otherwise touched by Phase 4's verification list.

**Out-of-Scope**: no change to the landing-page config schema, draft/publish
flow, or `ThemePicker` component itself.

**Execution Start Point**: read both `theme-presets.ts` files (already read in
full for this plan) and `apps/chrono-api/package.json`'s current `exports`
block before editing.

---

### Phase 2 — `resolveChronoEmailTheme` + boot-time registration

**Files to Update**
- New: `apps/chrono-api/src/lib/email-theme.ts`
- `apps/chrono-api/src/index.ts` (register at boot)

**Step-by-Step Tasks**
1. Write `email-theme.ts`:
   ```ts
   import { readPublishedLandingPage } from "agora/server/routes";
   import { CHRONO_THEME_PRESETS } from "../contracts/theme-presets";
   import type { EmailThemeTokens } from "agora/server";

   const HEX6 = /^#[0-9a-fA-F]{6}$/;

   /** Expand 3-digit shorthand, flatten an 8-digit alpha hex over a solid
    * `underSurface`, and drop anything that still isn't a plain 6-digit hex —
    * the foundation's color guard would otherwise silently drop it, and this
    * makes that explicit and correct here instead of an unexplained gap
    * downstream. */
   function normalizeHex(value: string, underSurface: string): string | undefined {
     let v = value;
     if (/^#[0-9a-fA-F]{3}$/.test(v)) {
       v = "#" + [...v.slice(1)].map((c) => c + c).join("");
     }
     if (/^#[0-9a-fA-F]{8}$/.test(v)) {
       // Flatten alpha over `underSurface` (both already 6-digit by this point
       // in the token map's declared order — background/card resolve first).
       v = flattenAlphaOverSolid(v, underSurface);
     }
     return HEX6.test(v) ? v : undefined;
   }

   function mapPresetTokens(
     tokens: Record<string, string>,
   ): Partial<EmailThemeTokens> {
     const card = normalizeHex(tokens.card ?? "", "#ffffff") ?? "#ffffff";
     return {
       background: normalizeHex(tokens.background ?? "", "#ffffff"),
       card,
       foreground: normalizeHex(tokens.foreground ?? "", "#ffffff"),
       mutedForeground: normalizeHex(tokens["muted-foreground"] ?? "", "#ffffff"),
       border: normalizeHex(tokens.border ?? "", card),
       primary: normalizeHex(tokens.primary ?? "", card),
       primaryForeground: normalizeHex(tokens["primary-foreground"] ?? "", card),
     };
   }

   /**
    * `tenantId` MUST come from already-resolved server context (`c.var.tenant`
    * / a foundation call site's own tenant id) — never client input — since
    * `readPublishedLandingPage` uses `withAdmin` and bypasses RLS (documented
    * in `apps/chrono-api/AGENTS.md`'s "Landing pages" section; the explicit
    * `tenantId` filter is the only isolation on that path). Every real caller
    * today already satisfies this (`member/routes.ts`'s `c.var.tenant`,
    * `agora/member-auth`'s own resolved `tenantId`) — this is a contract for
    * future callers, not a fix.
    *
    * Runs one `readPublishedLandingPage` read per call — no caching layer.
    * Accepted for this pass: email sends are not a hot path, and the read
    * already fails open (returns `null`) on any error, so an expensive read
    * degrades to an unthemed email rather than a failed send.
    */
   export async function resolveChronoEmailTheme(
     tenantId: string,
   ): Promise<{ light: Partial<EmailThemeTokens>; dark: Partial<EmailThemeTokens> } | null> {
     try {
       const published = await readPublishedLandingPage(tenantId);
       const key = published?.snapshot.themePreset ?? CHRONO_THEME_PRESETS.defaultKey;
       const preset = CHRONO_THEME_PRESETS.presets[key] ?? CHRONO_THEME_PRESETS.presets[CHRONO_THEME_PRESETS.defaultKey];
       if (!preset) return null;
       return { light: mapPresetTokens(preset.light), dark: mapPresetTokens(preset.dark) };
     } catch {
       return null; // fail-open — a themed email is not delivery-critical
     }
   }
   ```
   (Exact import paths/types to be confirmed against the foundation plan's
   final `agora/server` export list at implementation time — resolved by the
   2nd audit pass: no such helper exists anywhere in the repo today
   (`packages/agora`, `apps/chrono-api`, `apps/chrono-web` all grepped clean
   for `flattenAlpha`), so this is a genuinely new, small, local helper,
   defined inline in this same file, not imported from anywhere.
   `flattenAlphaOverSolid(hex8: string, underSurface: string): string` — the
   standard "alpha over a solid background" compositing formula, applied
   per-channel: given an 8-digit `#rrggbbaa` (the last 2 hex digits are the
   0-255 alpha) and a 6-digit `underSurface` hex, decompose both into
   `{r,g,b}` (0-255) plus `a` (0-1, `alpha255 / 255`), then for each channel
   `result = round(fg * a + bg * (1 - a))`, clamped to `[0, 255]`, and
   re-encode as a 2-digit hex byte. Return the composited 6-digit
   `#rrggbb` string (no alpha channel in the output — the whole point is to
   flatten it away). This is a pure, deterministic function with no
   dependency on any theme/rendering code — write it directly above
   `normalizeHex` in this same new file.)
2. In `apps/chrono-api/src/index.ts`, import `registerEmailThemeResolver` from
   `agora/server` and `resolveChronoEmailTheme` from `./lib/email-theme`, and
   call `registerEmailThemeResolver(resolveChronoEmailTheme);` once at boot,
   next to the existing `registerEmailQueueJob();` call (~line 37) — before
   `serve()` starts accepting traffic is not required here (both are
   synchronous statements in the same tick; the foundation plan's seam is
   deliberately a low-stakes mutable slot, not a frozen/throw-on-late
   registry like `auth-bootstrap.ts`'s permission registration). **Accepted
   gap**: `apps/chrono-api/src/seed.ts` and `src/e2e/run.ts` are independent
   process entrypoints that do not call this registration, so any email
   rendered from those paths uses `DEFAULT_EMAIL_THEME` rather than Chrono's
   preset — acceptable since neither sends real tenant-facing transactional
   email as part of its normal operation, and the foundation's once-per-process
   warning will surface it in logs if that assumption is ever wrong.

**Acceptance Criteria**
- A tenant with `neon-green` published on its landing page gets
  neon-green-tinted colors resolved for its emails; a tenant with no landing
  page published (or `elegant-gold`) gets the default palette (which itself
  degrades to the foundation's own `DEFAULT_EMAIL_THEME` neutral look, since
  `elegant-gold`'s tokens are the visual baseline).
- Every token `mapPresetTokens` returns is a plain 6-digit hex string (or
  `undefined`, never a raw 3-digit/8-digit value) — verified against both
  presets' `light` and `dark` maps.
- A landing-page read failure never blocks or breaks a send — verified by
  temporarily forcing `readPublishedLandingPage` to throw in a local test and
  confirming the email still sends with the default theme.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- Manual: publish a landing page with `neon-green` for a test tenant, trigger
  a member-invite email (`EMAIL_PROVIDER=console` to log rendered HTML), and
  visually confirm the button/card colors match `neon-green`'s tokens (not the
  raw, un-normalized alpha/shorthand values).

**Out-of-Scope**: no UI to preview "what will my emails look like" beyond the
existing `/branding/email-preview` route (which the foundation plan's Phase 2
already wires through the same theme-resolution path for its own call site —
Chrono inherits that for free once its resolver is registered, no Chrono-side
change needed to that specific route).

**Execution Start Point**: confirm the foundation plan's Phase 1 has landed
and exports `registerEmailThemeResolver`/`EmailThemeTokens` from `agora/server`
exactly as specified before starting this phase.

---

### Phase 3 — Migrate Chrono's own ad hoc email call sites

**Files to Update**
- `apps/chrono-api/src/modules/company-inquiry/public-routes.ts`
- `apps/chrono-api/src/modules/business-lead/routes.ts` (added in the 2nd
  audit pass — a fourth `renderBrandedEmail` call site the original pass
  missed; same "IZUR-internal, unbranded, same `SUPPORT_INBOX_EMAIL` inbox"
  class as `company-inquiry`, per this file's own comment at `:81-82`)
- `apps/chrono-api/src/modules/member/routes.ts`
- `apps/chrono-api/src/routes/rpc.ts` (`POST /rpc/integrations/email/test` —
  the third call site the original pass of this plan missed; Chrono's own
  copy of the scaffold's identical route, same fix as the foundation plan
  applies to `apps/agora-api`'s copy)

**Step-by-Step Tasks**
1. `company-inquiry/public-routes.ts` — this email is IZUR's own, unbranded,
   internal notification (never seen by a tenant's customer), so the owl asset
   applies here without contradicting the "never on a tenant-branded page"
   rule:
   ```ts
   const branding = {
     displayName: null, // leave null — let APP_NAME win, per render.ts's
                         // brandName fallback chain; do not hardcode "Chrono"
                         // here and silently override whatever APP_NAME the
                         // deployment actually uses
     emailFromName: null,
     emailReplyTo: null,
     emailLogoUrl: "https://chrono.izur.com.ph/brand/chrono-owl.png", // confirmed
                         // with the developer: this is the real, live,
                         // always-https production host serving
                         // apps/chrono-web/public/brand/chrono-owl.png —
                         // NOT derived from APP_DOMAIN (dev's own host is
                         // http://localtest.me:3000, which the renderer's
                         // https://-only guard would silently drop)
     logoDarkUrl: null,
     primaryColor: null,
     supportEmail: null,
   };
   ```
   Leave the rest of the handler (rate limiting, validation, the
   field-listing `bodyHtml`) unchanged; only the `branding` object gains a
   real logo instead of `null`.
2. `business-lead/routes.ts`'s `notifyBusinessLeadSubmitted` (added in the
   2nd audit pass) — identical treatment to step 1 above: its `branding`
   object (currently all-`null`, `:102-110`) gets the same
   `emailLogoUrl: "https://chrono.izur.com.ph/brand/chrono-owl.png"` literal,
   `displayName` stays `null` for the same `APP_NAME`-fallback reason. Leave
   `logoDarkUrl`/`primaryColor`/`supportEmail` as `null` and the rest of the
   handler (rate limiting, the durable `ChronoBusinessLeads` row, the
   best-effort try/catch) completely unchanged.
3. `member/routes.ts`'s `sendMemberOnboardingEmail` — add
   `logoDarkUrl: b?.logoDarkUrl ?? null` to both the `select()` projection and
   the constructed branding object (mirrors the fix the foundation plan makes
   to every other tenant-branded call site), and add
   `const theme = await resolveTenantEmailTheme(tenantId, branding)` (imported
   from `agora/server`) passed as the 3rd argument to `renderBrandedEmail`.
   Since Phase 2 already registered Chrono's resolver, this tenant now gets its
   real published theme automatically.
4. `apps/chrono-api/src/routes/rpc.ts`'s `POST /rpc/integrations/email/test` —
   same pattern as step 3 (it already does a full `.select()`, so
   `b.logoDarkUrl` is already available with no projection change): add
   `logoDarkUrl` to the branding object, resolve and pass `theme`.
5. Re-run `grep -rn "renderBrandedEmail" apps/chrono-api/src` as an explicit
   check (added in the 2nd audit pass) — must show exactly 4 call sites
   (steps 1-4 above), none missed a 5th time.

**Acceptance Criteria**
- A test company-inquiry submission's resulting email (sent to
  `SUPPORT_INBOX_EMAIL`) shows the Chrono owl mark in its header instead of
  plain brand-name text, **including when tested in local dev** (the
  confirmed-real, always-https URL makes this achievable in every
  environment, unlike the original placeholder).
- A test business-lead submission's resulting email (sent to the same
  `SUPPORT_INBOX_EMAIL`) shows the identical owl mark.
- The email's "From" name reflects the deployment's actual `APP_NAME` (or the
  existing platform default), not a hardcoded `"Chrono"` — unchanged from
  today's behavior for that field.
- An approve/reject decision email for a tenant with a published `neon-green`
  landing page now renders in that tenant's theme colors (previously always
  the generic white-card look).
- A test email from `/dashboard/settings/integrations` (email category) on a
  themed tenant also renders in that tenant's theme colors.
- No tenant-branded email anywhere in Chrono ever falls back to the owl mark —
  confirmed by grep: `emailLogoUrl:.*chrono-owl` appears in exactly **two**
  files (`company-inquiry/public-routes.ts`, `business-lead/routes.ts`) — and
  `grep -rn "renderBrandedEmail" apps/chrono-api/src` shows exactly 4 call
  sites total, matching this phase's Files to Update list.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `grep -rn "renderBrandedEmail" apps/chrono-api/src` — must show exactly 4
  call sites.
- Manual: submit a test company inquiry via `/support` or `/company/contact`
  and a test business-lead submission via `/discover` (dev), confirm both
  resulting console-logged (or real, if `SUPPORT_INBOX_EMAIL` + a real
  provider is configured) emails show the owl logo; approve/reject a test
  member application for a themed tenant and confirm the email matches its
  theme; send a test integration email for a themed tenant and confirm the
  same.

**Out-of-Scope**: no change to `notifyMemberOfDecision`'s copy
(`APPROVED_EMAIL_BODY`/`REJECTED_EMAIL_BODY`) beyond whatever markup migration
the foundation plan's component builders require for visual consistency — if
the developer wants the copy itself reworded, that is a separate, explicit
ask, not implied by "theming."

**Execution Start Point**: re-read all three files' current state (already
read in full for this plan) immediately before editing, since the foundation
plan's Phase 3 will have touched neighboring lines in `member-auth`/
`customer-auth` (different files, but confirm `member/routes.ts`/`rpc.ts`
themselves are untouched by that plan before assuming today's line numbers
still hold).

---

### Phase 4 — Verification + docs

**Files to Update**
- `apps/chrono-api/AGENTS.md` ("Theme presets" section — currently states
  "`apps/chrono-web/src/lib/theme-presets.ts` registers Chrono's palettes
  through the foundation's `buildThemePresetRegistry`", which is false after
  Phase 1; update it to name the new `apps/chrono-api/src/contracts/theme-presets.ts`
  location and note the preset now also drives transactional email, per
  `.ai/rules/implementation.md`'s "Completion Discipline")

**Step-by-Step Tasks**
1. Root `pnpm typecheck`.
2. Re-run `apps/chrono-web/e2e/tests/platform-admin/notification-templates.spec.ts`
   manually (per `.ai/rules/rbac.md`, this Playwright suite needs `pnpm dev`
   running, not `pnpm test:e2e`) — confirm no regression. (Phase 1 already
   re-ran the theme-preset-specific specs; this is the notification-templates
   regression check, distinct coverage.)
3. Manual visual pass: one themed tenant (non-default preset published), one
   unthemed tenant (no landing page published), confirm both render sensibly
   and neither errors.
4. Update `apps/chrono-api/AGENTS.md`'s "Theme presets" section.

**Acceptance Criteria**
- `pnpm typecheck` passes at the repo root.
- No regression in the existing notification-templates or theme-preset e2e
  specs.
- `apps/chrono-api/AGENTS.md` accurately describes the post-move file
  location and email's use of the preset.

**Verification Commands**
- `pnpm typecheck`

**Out-of-Scope**: no new Playwright spec — no new route, table, or dashboard
flow was added (`.ai/rules/e2e-testing.md`'s trigger conditions are not met by
this plan).

**Execution Start Point**: run after Phases 1–3 are all committed.

## CRUD & Feedback Contract

Not applicable — no new entity, table, or admin CRUD surface.

## After Implementation

Move this plan from `in-progress/` to `archive/` once all 4 phases are
committed and verified.
