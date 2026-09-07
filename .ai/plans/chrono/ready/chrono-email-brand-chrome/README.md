# Chrono email brand chrome (logo header + dotted background)

**Sessions:**
- Planning: agora-19 [75ff11]

## Summary

Every transactional email `apps/chrono-api` sends (member approval/rejection today;
whatever else is added later) currently renders through the foundation's
`emailLayout()` (`packages/agora/src/core/server/providers/email/components.ts`),
which shows the **tenant's own** logo/name in the header — a venue can white-label
these emails. The developer wants a different, additional layer on top: **Chrono's
own** owl + "CHRONO BY IZUR" wordmark lockup, on a dark dotted-pattern background,
always shown in the header of every Chrono email — the same visual identity as the
tenant-landing-page marketing header — with the tenant's own branding (name, primary
color, content) still driving the card body underneath.

Decisions already confirmed with the developer:
- The Chrono header **always** shows (not a fallback-when-no-tenant-logo case);
  tenant-set `emailLogoUrl`/`logoDarkUrl` no longer render in the header at all.
- This applies to **every** Chrono transactional email sent through
  `apps/chrono-api`, not just member approval/rejection — so the fix belongs at the
  shared `emailLayout()` call site, not duplicated per template.
- The logo is embedded as **inline base64** (not a hosted URL) so it renders
  correctly in local/dev sends and never depends on a deployed asset staying at a
  fixed path.

## Why a foundation change is required (and why it's still safe)

`packages/agora` must stay business-neutral (`.ai/rules/architecture.md`,
`.ai/rules/business-app.md` "Extension seams") — it can never hardcode Chrono's owl
logo. `emailLayout()` already has exactly this shape of seam for theme colors
(`EmailThemeResolver` / `registerEmailThemeResolver`, `theme.ts`): a business app
registers a resolver once at boot, the foundation calls it if present, and the
scaffold (`apps/agora-api`, no resolver registered) is unaffected. This plan adds a
**second**, small seam of the identical shape — `registerEmailChromeOverride()` — so
`packages/agora` still ships zero Chrono-specific assets or markup; it only gains a
registration slot, mirroring an already-accepted pattern instead of inventing a new
one.

## Files to Update

1. `packages/agora/src/core/server/providers/email/theme.ts` — add the override type
   + registration function + getter (mirrors `EmailThemeResolver` exactly).
2. `packages/agora/src/core/server/providers/email/components.ts` — `emailLayout()`
   consumes the override for the header markup and the outer body style.
3. `packages/agora/src/core/server/providers/email/index.ts` — re-export the new
   function/type.
4. `packages/agora/src/core/server/index.ts` — re-export it up to the public
   `agora/server` subpath.
5. `apps/chrono-api/src/assets/email/chrono-logo-header.png` — **new binary asset**
   (already staged in the working tree at this path — the composed owl + "CHRONO BY
   IZUR" lockup image the developer supplied, 552×150 PNG).
6. `apps/chrono-api/src/lib/email-brand.ts` — **new file**. Reads the PNG above,
   base64-encodes it once at module load, and exports the `EmailChromeOverride`
   object (header `<img>` markup + the dark dotted-background outer style).
7. `apps/chrono-api/src/index.ts` — one new import + one new call, right next to the
   existing `registerEmailThemeResolver(resolveChronoEmailTheme)` line (currently
   line 40).

## Step-by-Step Tasks

### Phase 1 — Foundation seam (`packages/agora`)

1. In `theme.ts`, add:
   ```ts
   export type EmailChromeOverride = {
     /** Replaces the tenant logo/name header block entirely when present. */
     headerHtml: string;
     /** Replaces `body`'s default `background:#f9fafb` (light) /
      *  `#0b0b0c` (dark) inline style entirely when present — a single value
      *  used for both color schemes, since an override is a fixed brand
      *  choice, not something that should invert in dark mode. */
     outerBodyStyle?: string;
   };

   let emailChromeOverride: EmailChromeOverride | null = null;

   export function registerEmailChromeOverride(override: EmailChromeOverride): void {
     emailChromeOverride = override;
   }

   export function getEmailChromeOverride(): EmailChromeOverride | null {
     return emailChromeOverride;
   }
   ```
   Place it directly below the existing `registerEmailThemeResolver`/
   `emailThemeResolver` block so the two seams read as siblings.
2. In `components.ts`, `emailLayout()`:
   - Import `getEmailChromeOverride` from `./theme`.
   - At the top of the function: `const chrome = getEmailChromeOverride();`
   - Replace the `logoOk`/`logoDarkOk`/text-fallback branching for `headerHtml` with:
     `if/else` — `chrome ? chrome.headerHtml : <existing three-way branch unchanged>`.
     The existing tenant-logo branch stays byte-for-byte as the `else` path (this
     preserves current scaffold/no-override behavior).
   - In the returned template string, change the `<body class="eb-bg" style="margin:0;background:#f9fafb;...">` 
     literal to interpolate `chrome?.outerBodyStyle ?? "background:#f9fafb;"` (keep the
     rest of the style string — font-family etc. — unconditional and unchanged).
   - Do not touch the `@media (prefers-color-scheme: dark)` block's `.eb-bg` dark
     override — when a chrome override is active its `outerBodyStyle` inline value
     already wins over that rule's `!important`... **note this is a real conflict**:
     the existing dark-mode CSS rule uses `!important` and would still override an
     inline style. Add `.eb-bg-fixed { background:${escaped outerBodyStyle} !important; }`
     as a new class applied instead of `.eb-bg` when `chrome` is present, and skip
     emitting the `@media (dark) { .eb-bg {...} }` rule's background line in that
     case (the override is a single fixed look in both color schemes, per the
     decision above) — keep every other dark-mode rule (`.eb-card`, `.eb-text`, CTA
     colors) unchanged, since the card content still respects the tenant's theme.
3. In `providers/email/index.ts`, add `registerEmailChromeOverride`, `getEmailChromeOverride`,
   `type EmailChromeOverride` to the existing `export { ... } from "./theme"` block.
4. In `core/server/index.ts`, add the same three names into the existing
   `export { ... } from "./providers/email"` block (next to
   `registerEmailThemeResolver`).

### Phase 2 — Chrono asset + registration

5. Confirm `apps/chrono-api/src/assets/email/chrono-logo-header.png` is committed
   (already staged in the working tree by planning).
6. Create `apps/chrono-api/src/lib/email-brand.ts`:
   ```ts
   import { readFileSync } from "node:fs";
   import { dirname, join } from "node:path";
   import { fileURLToPath } from "node:url";
   import type { EmailChromeOverride } from "agora/server";

   const __dirname = dirname(fileURLToPath(import.meta.url));
   const LOGO_PATH = join(__dirname, "../assets/email/chrono-logo-header.png");
   const LOGO_DATA_URI = `data:image/png;base64,${readFileSync(LOGO_PATH).toString("base64")}`;

   /** Single-layer dot grid, matching the density of `.premium-dots`'s
    * tightest layer (apps/chrono-web/src/app/globals.css) — kept to one
    * radial-gradient layer (not three) because email-client background-image
    * support is inconsistent for stacked gradients; a fixed gold tone is used
    * instead of `.premium-dots`'s `color-mix(var(--primary), ...)` since email
    * CSS has no custom-property/color-mix support. */
   const DOTTED_BACKGROUND =
     "background-color:#080806;" +
     "background-image:radial-gradient(rgba(214,168,79,0.14) 1px, transparent 1px);" +
     "background-size:24px 24px;";

   export const CHRONO_EMAIL_CHROME: EmailChromeOverride = {
     headerHtml: `<img src="${LOGO_DATA_URI}" alt="Chrono by IZUR" width="184" height="50" style="display:block;margin:0 auto;max-width:184px;width:100%;height:auto" />`,
     outerBodyStyle: DOTTED_BACKGROUND,
   };
   ```
7. In `apps/chrono-api/src/index.ts`:
   - Add `registerEmailChromeOverride` to the existing `import { ... } from "agora/server"` block.
   - Add `import { CHRONO_EMAIL_CHROME } from "./lib/email-brand";`.
   - Add `registerEmailChromeOverride(CHRONO_EMAIL_CHROME);` directly below the
     existing `registerEmailThemeResolver(resolveChronoEmailTheme);` line.

### Phase 3 — Verification

8. `pnpm typecheck` (root) — must pass; no schema/RLS/tenant-table touched, so
   `rls:proof` is not required for this change (confirm no `withTenant`/`APP_TENANT_TABLES`
   edits crept in).
9. Manual visual check (no new e2e spec required — this is chrome on an existing
   send path, not a new tenant-scoped resource/route/dashboard flow per
   `.ai/rules/e2e-testing.md`'s trigger list): with `EMAIL_PROVIDER=console` (the
   local default), trigger a member approval in a running dev instance
   (`pnpm --filter @agora/chrono-api dev`, approve a pending member profile via the
   existing dashboard/API flow) and inspect the logged HTML — either paste it into a
   local `.html` file and open it in a browser, or use an email-client preview tool —
   confirming: the Chrono logo renders (not the tenant's own logo/name), the dotted
   dark background appears behind the header, and the card content below still shows
   the tenant's own primary color / copy unchanged.
10. Re-run the same check against `apps/agora-api`/`apps/agora-web` (the scaffold) —
    since it never calls `registerEmailChromeOverride`, its own reset-password/
    verify-email/invite emails must render **exactly as before** (tenant logo/name
    header, `#f9fafb`/`#0b0b0c` plain background) — this is the regression guard that
    proves the seam is additive, not a global default.

## Acceptance Criteria

- Every email `apps/chrono-api` sends (approval, rejection, and any future template
  going through `renderBrandedEmail`) shows the Chrono owl+wordmark header and dark
  dotted background, regardless of the tenant's own `emailLogoUrl`/`logoDarkUrl`.
- `apps/agora-api`/`apps/agora-web` foundation emails are visually unchanged (no
  chrome override registered there).
- No tenant-branding data or logic is deleted — `tenantBranding.emailLogoUrl` etc.
  are still read and still drive `renderBrandedEmail`'s `from` name and the card's
  primary color; they simply no longer render as the *header image* for Chrono.
- `packages/agora` contains zero Chrono-specific strings, colors, or assets — only
  the generic `EmailChromeOverride` type/registration slot.
- `pnpm typecheck` passes.

## Out-of-Scope

- Re-theming the dotted background per the tenant's own theme preset/primary color
  (the decision above is a **fixed** Chrono brand look in both light and dark mode,
  not tenant-reactive) — a future request, not built here.
- Any change to which tenant-branding fields exist or how `resolveTenantEmailTheme`
  resolves card/button colors — untouched.
- A hosted-URL alternative to the inline-base64 logo — explicitly decided against.
- Extending this seam to SMS or in-app notifications — email only.
- A new admin-editable override for the approval/rejection copy itself (already
  noted as an existing, separate gap in `member/routes.ts`'s own comment) — not part
  of this plan.

## Execution Start Point

Start at Phase 1, Step 1 (`packages/agora/src/core/server/providers/email/theme.ts`).
Per `.ai/rules/planning.md` and the developer's own standing preference, this session
does not implement — once this plan is accepted, dispatch each phase to a fresh
subagent session and commit each phase separately.
