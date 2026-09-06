# Chrono email theming: wire the tenant's theme preset + brand asset into its emails

Status: Draft
Owner: Chrono's email call sites (`apps/chrono-api`)

**Sessions:**
- Planning: consolidate-customers-members-page [7ffb50]

## Depends on

`.ai/plans/agora/draft/email-design-system/README.md` **must land first.** This
plan registers Chrono's own theme-preset palette into the resolver seam that
plan builds (`registerEmailThemeResolver`) and consumes its new
`EmailThemeTokens`/`resolveTenantEmailTheme` API. Nothing here is buildable
before that plan's Phase 1–2 are committed. Once that plan is archived, update
this line to point at its archived path.

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
`SUPPORT_INBOX_EMAIL` — Chrono's own team, not a tenant's customer), where it
is genuinely Chrono's own identity, not a stand-in for a tenant's.

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
  (`TenantLandingPages`, `packages/agora/src/core/contracts/landing.ts:374`) —
  **not** on `tenantBranding`. It currently only affects the public `/about`
  page (`app/layout.tsx`'s `themePresetCss(CHRONO_THEME_PRESETS,
  landing?.themePreset)`).
- This file lives in `apps/chrono-web` — a **browser** app. Email is sent from
  `apps/chrono-api` (server). `chrono-api` cannot import from `chrono-web`
  (dependency direction is `chrono-web → chrono-api`, per
  `apps/chrono-api/package.json`'s existing subpath `exports` map that
  `chrono-web` already imports type/value content from — see Phase 1).
- Every Chrono-owned email call site builds its own ad hoc `EmailBranding`
  object with no theme and no `logoDarkUrl`:
  - `apps/chrono-api/src/modules/company-inquiry/public-routes.ts` — IZUR's own
    unbranded internal inbox notification (`branding` is all-`null`).
  - `apps/chrono-api/src/modules/member/routes.ts`'s `sendMemberOnboardingEmail`
    — tenant-branded (reads `tenantBranding`), backs the approve/reject-decision
    emails (`notifyMemberOfDecision`).
  - Chrono's portal member invite/reset emails are NOT a Chrono call site —
    they go through the foundation's `agora/member-auth` (`inviteTenantMember`,
    imported by `member/routes.ts`). Per the foundation plan's Phase 3, that
    shared helper already resolves the registered theme internally — **once
    this plan's Phase 2 registers Chrono's resolver, those two flows are
    covered automatically, with zero Chrono-side code change.**

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

**No new admin UI, no new route, no schema change** — this is exclusively a
"which colors does an existing email use" change.

## Pass 2 — Technical Planning

**Boundary**: `apps/chrono-api` (new file + 3 edits), `apps/chrono-web` (1 file
reduced to a re-export), `apps/chrono-api/package.json` (1 new export). No
`packages/agora` changes (that's the dependency, already landed). No schema
change, no RLS impact — `rls:proof` not applicable.

### Chrono's `EmailThemeTokens` mapping

`CHRONO_THEME_PRESETS`'s palettes already use key names that map almost
1:1 onto the foundation's `EmailThemeTokens` (deliberately named to match, per
the foundation plan):

| `ThemePresetDefinition.light`/`.dark` key | `EmailThemeTokens` field |
|---|---|
| `background` | `background` |
| `card` | `card` |
| `foreground` | `foreground` |
| `muted-foreground` | `mutedForeground` |
| `border` | `border` |
| `primary` | `primary` |
| `primary-foreground` | `primaryForeground` |

## Out of Scope

- Any change to `packages/agora` (the foundation plan's job).
- New Chrono email flows for modules that don't send email today (`reservation`,
  `wallet`, `security-alert`, `loyalty`) — none of these send email currently
  (verified by grep across `apps/chrono-api/src/modules`); adding new
  transactional flows for them is separate, future work.
- A dark-mode-specific variant of `chrono-owl.png`.
- Moving `theme-presets.ts` changes anything about the landing-page feature
  itself — Phase 1 is a pure relocation, zero behavior change for
  `/dashboard/settings/landing-page` or the public `/about` page.

## Phase Design

### Phase 1 — Share `CHRONO_THEME_PRESETS` with `chrono-api`

**Files to Update**
- New: `apps/chrono-api/src/theme-presets.ts`
- `apps/chrono-api/package.json` (add `"./theme-presets"` to `exports`)
- `apps/chrono-web/src/lib/theme-presets.ts` (replace body with a re-export)

**Step-by-Step Tasks**
1. Move the full content of `apps/chrono-web/src/lib/theme-presets.ts`
   (the `ELEGANT_GOLD_LIGHT`/`_DARK`, `NEON_GREEN_LIGHT`/`_DARK` objects, the
   `CHRONO_THEME_PRESETS = buildThemePresetRegistry(...)` call, and
   `presetSwatch()`) verbatim into a new `apps/chrono-api/src/theme-presets.ts`.
   It only imports `buildThemePresetRegistry` from `agora` — already
   browser-safe, no server-only imports, so it is safe to also serve
   `chrono-web`'s client-side `ThemePicker` bundle (mirrors the existing
   `./station`/`./realtime` subpath exports, which are similarly pure leaf
   contract files with no DB/server imports).
2. Add `"./theme-presets": "./src/theme-presets.ts"` to
   `apps/chrono-api/package.json`'s `"exports"` map, alongside `./app`,
   `./realtime`, `./station`.
3. Replace `apps/chrono-web/src/lib/theme-presets.ts`'s body with:
   ```ts
   export { CHRONO_THEME_PRESETS, presetSwatch } from "@agora/chrono-api/theme-presets";
   ```
   No other file changes — `app/layout.tsx`, `theme-picker.tsx`, and any other
   importer of `@/lib/theme-presets` keep working unchanged (same named
   exports, same import path).

**Acceptance Criteria**
- `apps/chrono-web/src/lib/theme-presets.ts` shrinks to a single re-export
  line (plus its file-level comment).
- `/dashboard/settings/landing-page`'s theme picker and the public `/about`
  page render identically before and after this phase (pure move, zero
  behavior change).
- `pnpm --filter @agora/chrono-api typecheck` and
  `pnpm --filter @agora/chrono-web typecheck` both pass.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-web typecheck`
- Manual: `pnpm --filter @agora/chrono-web dev`, open
  `/dashboard/settings/landing-page`, confirm the theme picker still lists
  both presets and swatches correctly; open a tenant's `/about` page, confirm
  its preset styling is unchanged.

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
   import { CHRONO_THEME_PRESETS } from "../theme-presets";
   import type { EmailThemeTokens } from "agora/server";

   function mapPresetTokens(
     tokens: Record<string, string>,
   ): Partial<EmailThemeTokens> {
     return {
       background: tokens.background,
       card: tokens.card,
       foreground: tokens.foreground,
       mutedForeground: tokens["muted-foreground"],
       border: tokens.border,
       primary: tokens.primary,
       primaryForeground: tokens["primary-foreground"],
     };
   }

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
   final `agora/server` export list at implementation time — `EmailThemeTokens`
   must be exported from there per that plan's Phase 1.)
2. In `apps/chrono-api/src/index.ts`, import `registerEmailThemeResolver` from
   `agora/server` and `resolveChronoEmailTheme` from `./lib/email-theme`, and
   call `registerEmailThemeResolver(resolveChronoEmailTheme);` once at boot,
   next to the existing `registerEmailQueueJob();` call (~line 37).

**Acceptance Criteria**
- A tenant with `neon-green` published on its landing page gets
  neon-green-tinted colors resolved for its emails; a tenant with no landing
  page published (or `elegant-gold`) gets the default palette (which itself
  degrades to the foundation's own `DEFAULT_EMAIL_THEME` neutral look, since
  `elegant-gold`'s tokens are the visual baseline).
- A landing-page read failure never blocks or breaks a send — verified by
  temporarily forcing `readPublishedLandingPage` to throw in a local test and
  confirming the email still sends with the default theme.

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- Manual: publish a landing page with `neon-green` for a test tenant, trigger
  a member-invite email (`EMAIL_PROVIDER=console` to log rendered HTML), and
  visually confirm the button/card colors match `neon-green`'s tokens.

**Out-of-Scope**: no UI to preview "what will my emails look like" beyond the
existing `/branding/email-preview` route (which does not yet call this
resolver — see Phase 3's note on whether to wire it in, currently left as-is
since that route already accepts a `theme` param the caller passes in, per the
foundation plan's Phase 2 changes to that route).

**Execution Start Point**: confirm the foundation plan's Phase 1 has landed
and exports `registerEmailThemeResolver`/`EmailThemeTokens` from `agora/server`
exactly as specified before starting this phase.

---

### Phase 3 — Migrate Chrono's own ad hoc email call sites

**Files to Update**
- `apps/chrono-api/src/modules/company-inquiry/public-routes.ts`
- `apps/chrono-api/src/modules/member/routes.ts`

**Step-by-Step Tasks**
1. `company-inquiry/public-routes.ts` — this email is IZUR's own, unbranded,
   internal notification (never seen by a tenant's customer), so the owl asset
   applies here without contradicting the "never on a tenant-branded page"
   rule:
   ```ts
   const appDomain = process.env.APP_DOMAIN ?? "localtest.me:3000";
   const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
   const branding = {
     displayName: "Chrono",
     emailFromName: null,
     emailReplyTo: null,
     emailLogoUrl: `${scheme}://${appDomain}/brand/chrono-owl.png`,
     logoDarkUrl: null,
     primaryColor: null,
     supportEmail: null,
   };
   ```
   (mirrors the existing `APP_DOMAIN`/scheme construction already used in
   `invites/service.ts`'s `acceptInviteUrl` and this same file's own request
   handling — no new env var). Leave the rest of the handler (rate limiting,
   validation, the field-listing `bodyHtml`) unchanged; only the `branding`
   object gains a real logo instead of `null`.
2. `member/routes.ts`'s `sendMemberOnboardingEmail` — add
   `logoDarkUrl: b?.logoDarkUrl ?? null` to both the `select()` projection and
   the constructed branding object (mirrors the fix the foundation plan makes
   to every other tenant-branded call site), and add
   `const theme = await resolveTenantEmailTheme(tenantId, branding)` (imported
   from `agora/server`) passed as the 3rd argument to `renderBrandedEmail`.
   Since Phase 2 already registered Chrono's resolver, this tenant now gets its
   real published theme automatically.

**Acceptance Criteria**
- A test company-inquiry submission's resulting email (sent to
  `SUPPORT_INBOX_EMAIL`) shows the Chrono owl mark in its header instead of
  plain brand-name text.
- An approve/reject decision email for a tenant with a published `neon-green`
  landing page now renders in that tenant's theme colors (previously always
  the generic white-card look).
- No tenant-branded email anywhere in Chrono ever falls back to the owl mark —
  confirmed by grep: `emailLogoUrl: .*chrono-owl` appears in exactly one file
  (`company-inquiry/public-routes.ts`).

**Verification Commands**
- `pnpm --filter @agora/chrono-api typecheck`
- Manual: submit a test company inquiry via `/support` or `/company/contact`
  (dev), confirm the resulting console-logged (or real, if
  `SUPPORT_INBOX_EMAIL` + a real provider is configured) email shows the owl
  logo; approve/reject a test member application for a themed tenant and
  confirm the email matches its theme.

**Out-of-Scope**: no change to `notifyMemberOfDecision`'s copy
(`APPROVED_EMAIL_BODY`/`REJECTED_EMAIL_BODY`) beyond whatever markup migration
the foundation plan's component builders require for visual consistency — if
the developer wants the copy itself reworded, that is a separate, explicit
ask, not implied by "theming."

**Execution Start Point**: re-read both files' current state (already read in
full for this plan) immediately before editing, since the foundation plan's
Phase 3 will have touched neighboring lines in `member-auth`/`customer-auth`
(different files, but confirm `member/routes.ts` itself is untouched by that
plan before assuming today's line numbers still hold).

---

### Phase 4 — Verification

**Files to Update**: none (verification only).

**Step-by-Step Tasks**
1. Root `pnpm typecheck`.
2. Re-run `apps/chrono-web/e2e/tests/platform-admin/notification-templates.spec.ts`
   manually (per `.ai/rules/rbac.md`, this Playwright suite needs `pnpm dev`
   running, not `pnpm test:e2e`) — confirm no regression.
3. Manual visual pass: one themed tenant (non-default preset published), one
   unthemed tenant (no landing page published), confirm both render sensibly
   and neither errors.

**Acceptance Criteria**
- `pnpm typecheck` passes at the repo root.
- No regression in the existing notification-templates e2e spec.

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
