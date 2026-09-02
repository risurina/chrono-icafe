# Chrono — apex + tenant landing rebrand

**Status:** Draft — awaiting developer approval.

## What this is

`apps/chrono-web/src/app/page.tsx` is still a byte-for-byte copy of the
`apps/agora-web` scaffold's landing page: it markets *Agora, the multi-tenant
foundation* to *developers*. Chrono is a gaming/internet-café venue-management
product sold to *venue operators*, so every section of that page is aimed at the
wrong audience.

This plan rebrands both halves of that file:

1. **Apex half** (`tenant === null`, current lines 63–517) — the public marketing
   page at `CHRONO_DOMAIN`. Restructured sections + all-new copy.
2. **Tenant-host half** (lines 519–675) — the root page on
   `{slug}.CHRONO_DOMAIN`, currently a generic "Customers / Staff" sign-in
   splitter. Rebranded to a venue-aware welcome that links the surfaces Chrono
   actually has (`/stations`, `/about`, `/portal/*`).

Plus the app-level metadata defaults in `apps/chrono-web/src/app/layout.tsx`,
which still say "Agora — Multi-tenant base".

### Copy source — resolved

The task brief asked to port copy from the oikos prior art
(`C:\Users\ronni\project\izur\oikos`). **That source is not present on this
machine** (a Windows path; no `oikos` directory exists locally). Copy is
therefore drafted from Chrono's documented domain in `apps/chrono-api/AGENTS.md`
and the shipped modules, and is explicitly **placeholder-quality marketing
prose the developer is expected to edit**. If the oikos copy is later made
available, swapping it in touches only the data arrays at the top of each half —
no structural rework.

## Pass 1 — Workflow Analysis

- **Who uses this**: apex half — an anonymous prospective *venue operator*
  evaluating Chrono. Tenant half — an anonymous *walk-in customer* of one venue,
  plus that venue's *staff* arriving at the host root.
- **Workflow (apex)**: lands on `CHRONO_DOMAIN` → understands what Chrono runs
  (stations, sessions, wallet, shifts, POS, reservations) → "Start free trial" →
  `/sign-up`, which provisions the tenant exactly as today.
- **Workflow (tenant root)**: lands on `{slug}.CHRONO_DOMAIN` → sees the venue's
  branding → picks one of: see live seat availability (`/stations`), read about
  the venue (`/about`), sign in / create a member account (`/portal/*`), or staff
  sign-in (`/login`).
- **Failure cases**: both halves are already resilient — `fetchTenant()` swallows
  fetch errors and returns `null` (apex render), and `getPublicBranding()` is
  optional. Restructuring must not introduce a new required fetch. The
  `/stations` and `/about` links must degrade gracefully for a tenant that has
  no branches/stations — link presence is decided from data the page already
  has, or the link is unconditional and those pages handle their own empty/404
  state (they already do).
- **Audit/notifications**: none. Both halves are read-only public pages.

## Pass 2 — Technical Planning

- **No API, schema, contract, RLS, permission, or tenancy change.** This is
  presentation-layer only. `rls:proof` is unaffected but will still be run per
  the repo's before-you-finish checklist (cheap, and proves nothing regressed).
- **Component-first UI** (`.ai/rules/component-first-ui.md`): every section is
  composed from existing `agora/ui` primitives already imported by this file —
  `PageShell`, `SiteHeader`, `SiteFooter`, `Main`, `Section`, `Grid`, `Stack`,
  `Row`, `Card*`, `Badge`, `StatTile`, `Testimonial`, `FaqItem`, `BrandHeader`,
  `ThemeToggle`, `buttonVariants`. **No new primitive is needed and none is
  added.** Raw `<div>` usage is limited to the exact wrappers already present in
  the file (gradient/mask overlays, section padding) — the rebrand does not add
  new raw chrome.
- **Icons**: lucide, same import style. The Agora-specific set (`Map`,
  `Layers`, `Globe`, `KeyRound`) is swapped for Chrono-appropriate ones
  (`MonitorPlay`, `Timer`, `Wallet`, `Users`, `CalendarClock`, `Store`,
  `ShoppingCart`, `ShieldCheck`, `Building2`, `LifeBuoy`) — all already in the
  installed `lucide-react`.
- **Nothing in `packages/agora` is touched.** Chrono brand copy is
  business-specific and belongs in the business app
  (`.ai/rules/business-app.md`). The scaffold's own
  `apps/agora-web/src/app/page.tsx` stays generic and is **out of scope**.

### Files to update

| File | Change |
|---|---|
| `apps/chrono-web/src/app/page.tsx` | Both halves: new data arrays + restructured JSX sections |
| `apps/chrono-web/src/app/layout.tsx` | `DEFAULT_TITLE` / `DEFAULT_DESCRIPTION` → Chrono |
| `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts` | Update any assertion that pins the old copy (verify first — it may target `/about`, not `/`) |

Out of scope: `apps/agora-web/**` (scaffold stays neutral), `packages/agora/**`,
theme tokens / colors / logo assets, the `/about` tenant landing page (already
shipped by the archived `tenant-landing` plan), `/stations`, and any API route.

---

## Phase 1 — Apex marketing page

**Section structure — old → new**

| Old (Agora) | New (Chrono) |
|---|---|
| Hero: "The foundation for multi-tenant apps" + tech-stack badges + 4 dev stats | Hero: venue-operator pitch + trust line + 4 operator stats |
| Features: 4 × "why Agora" (multi-tenancy, RLS, custom domains, extensible) | **Features: 6 × Chrono module cards** — Stations & floor map, Timed sessions, Wallet & credits, Members & loyalty, Shifts & staff, POS & reservations |
| Without/With Agora comparison | **Kept, re-aimed**: "Running a venue on spreadsheets and a whiteboard" vs "Running it on Chrono" |
| Testimonials (3 developers) | **Removed** — no real customers; fabricated venue testimonials on a live marketing page are not acceptable |
| Roles: Owner / Admin / Staff | **Replaced with "Built for your whole floor"**: Owner, Manager (admin), Floor staff, Customer — describing who touches which surface |
| Onboarding: 3 dev steps | **Kept, re-aimed**: Create your venue → Add branches & stations → Open the floor |
| FAQ (6 dev questions) | **FAQ (6 operator questions)**: multi-branch, kiosk/PC-client, offline, payments/wallet, migrating existing data, pricing |
| CTA: "Create a workspace" | CTA: "Start your venue on Chrono" |
| — | **New section: Surfaces** — a short 3-card band naming the real surfaces (staff dashboard, customer portal, public live-stations page) so a prospect sees what they actually get |

**Tasks**

1. Replace the `highlights` array with 6 Chrono module entries (icon, title,
   description) drawn from `apps/chrono-api/AGENTS.md`'s module list; render in
   the existing `<Grid cols={2}>` (renders 3 rows).
2. Replace `withoutAgora`/`withAgora` with `withoutChrono`/`withChrono`; rename
   the card title "With Agora" → "With Chrono".
3. Delete the `testimonials` array, its `<Section>`, and the now-unused
   `Testimonial` import.
4. Replace `roles` with the four-audience array; widen its `<Grid cols={3}>` to
   `cols={4}` (or keep 3 + a fourth wrapping — decide at implementation, whichever
   the existing `Grid` handles cleanly).
5. Replace `steps` and `stats` and `faqs` with the Chrono copy.
6. Add the Surfaces section between Roles and Onboarding, built from `Card` +
   `CardHeader`/`CardTitle`/`CardDescription` — same shape as the roles grid.
7. Rebrand `SiteHeader` brand (`Map` icon + "Agora" → `Timer` icon + "Chrono"),
   the hero `Badge` ("Agora · Multi-tenant base" → "Chrono · Venue management"),
   the tech-stack badge row (drop it — operators don't care about the stack), the
   hero copy, the "Why Agora" eyebrow, the closing CTA, and the `SiteFooter`
   brand line.
8. Update `layout.tsx` `DEFAULT_TITLE`/`DEFAULT_DESCRIPTION`.

**Acceptance criteria**

- No occurrence of "Agora" remains in `apps/chrono-web/src/app/page.tsx` or in
  the metadata defaults of `apps/chrono-web/src/app/layout.tsx`.
- Every section still renders from `agora/ui` primitives; no new raw
  `div`/`header`/`nav`/`section` chrome beyond what the file already had.
- No unused imports (`Map`, `Layers`, `Globe`, `Testimonial`, `X`/`Check` only if
  the comparison section were dropped — it isn't).
- No fabricated customer quotes or invented metrics anywhere on the page. Stats
  describe product capability (e.g. "Branches per venue — Unlimited"), never
  usage numbers Chrono has not earned.

**Verification**

```
pnpm --filter @agora/chrono-web typecheck   # or: turbo run typecheck
pnpm --filter @agora/chrono-web lint
```
Plus a visual pass at `localhost:3000` on the apex host with
`pnpm --filter @agora/chrono-web dev` (light + dark theme, mobile width).

**Execution start point:** `apps/chrono-web/src/app/page.tsx:70` (the
`highlights` array).

---

## Phase 2 — Tenant-host root page

**Section structure — old → new**

| Old | New |
|---|---|
| Hero: "Welcome to {venue}" + Create account / Sign in | **Kept**, plus a primary "See live stations" CTA when the venue is reachable |
| 3 generic highlight cards (manage account / secure / support) | **Venue-aware trio**: Live seat availability, Your wallet & session history, Book ahead (reservations) |
| "Choose how you'd like to sign in" — Customers vs Staff cards | **Kept, expanded to 3 cards**: Customers (`/portal/*`), Staff (`/login`), and "About this venue" (`/about`) — the shipped tenant landing page, currently unlinked from the root |

**Tasks**

1. Replace `tenantHighlights` with the venue-aware trio; swap `KeyRound`/
   `ShieldIcon`/`LifeBuoy` for `MonitorPlay`/`Wallet`/`CalendarClock`.
2. Add a `/stations` CTA to the hero `Row` and an `/about` card to the sign-in
   grid (`Grid cols={2}` → `cols={3}`).
3. Re-word the hero subhead from "Sign in to your account, or create one" to
   venue-customer language.
4. Leave `BrandHeader`, `branding.tagline`, `heading`, and the footer's
   `{heading}` untouched — those are already per-tenant and correct.

**Acceptance criteria**

- A tenant with no stations/branches still renders without error; `/stations`
  and `/about` handle their own empty/404 states (verified, not assumed).
- Tenant branding (display name, logo, tagline, colors) still drives the page —
  no hard-coded Chrono brand leaks into the tenant-host half.
- The existing `apps/chrono-web/e2e/tests/tenant-landing/public-page.spec.ts`
  still passes; update it only if it asserted on copy this phase changed.

**Verification**

```
pnpm --filter @agora/chrono-web typecheck
pnpm --filter @agora/api rls:proof            # unchanged, run per checklist
```
Visual pass on `acme.localtest.me:3000` with a seeded tenant.

**Execution start point:** `apps/chrono-web/src/app/page.tsx:522`
(`tenantHighlights`).

---

## Phase 3 — Verify & commit

1. `turbo run typecheck` (whole workspace).
2. `pnpm --filter @agora/chrono-web lint`.
3. Run the tenant-landing e2e spec if the dev servers are up; otherwise record
   that it was not run.
4. Commit Phase 1 and Phase 2 separately
   (`feat(chrono/landing): phase 1 — apex marketing page`, `phase 2 — tenant
   root page`), per `.ai/rules/implementation.md`.
5. Move this plan to `.ai/plans/chrono/archive/chrono-landing/`.

## Open questions for the developer

1. **Product name on the page** — "Chrono" as-is, or is there a real commercial
   name/wordmark/tagline to use instead? The draft uses "Chrono".
2. **Pricing** — the current page has no pricing section and this plan doesn't
   add one. Should it?
3. **Testimonials** — removed rather than fabricated. If real venue quotes exist,
   the section comes back unchanged.
