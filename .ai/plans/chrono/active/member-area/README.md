# Chrono member area — `/member/*` (replicate the reference member pages)

Plan file for `.ai/plans/chrono/active/member-area/README.md` (copied there in Phase 0).

## Context

The reference site `gaming.chrono.izur.com.ph/member` (prior art at
`/Users/risurina/karta/karta-tenant/apps/chrono-web/src/app/tenant/landing/member/**`)
gives a signed-in customer a gold-on-black member area: the public tenant nav on top with a
name/avatar dropdown, a second tab bar (Dashboard, Session, Connect, Reservations, Promos,
Wallet, History, Leaderboard [disabled], Profile, Settings), a playtime hero, wallet and
membership cards, a premium store strip, and a station-picker reservations page.

Chrono in agora already has a member surface, but at `/portal` with a bare 14 px header and
no navigation: `apps/chrono-web/src/app/(member-portal)/portal/{tenant-portal-home,
reservations/page,inquiries/page}.tsx`, backed by `memberMiddleware()` routes at
`/portal/{members,wallet,credits,sessions,reservations,inquiries}` in `apps/chrono-api`.
This plan re-shells that surface at `/member/*`, adds the missing member-facing API reads
(loyalty, session list, promos, credit catalog), one money-moving member route
(wallet-funded credit purchase), and two small foundation additions (member name update,
change-password). It follows the "improve, don't port" rule: match the reference visually,
write everything fresh against `.ai/rules/*`, and make the parts a future app would change
(nav, menu, card order) configuration.

## Decisions (from the developer, 2026-09-04)

| Decision | Choice |
|---|---|
| URL | `/member/*` on tenant hosts (assumption: the answer pointed at the prior-art app, whose tenant member area is `/member`). `/portal` → `/member`, `/portal/reservations` → `/member/reservations`, `/portal/inquiries` → `/member/inquiries` on tenant hosts. `/portal/{login,sign-up,forgot,reset,accept-invite}` stay (foundation email links hardcode `/portal/reset` and `/portal/accept-invite`). Apex `/portal` (global-customer home) unchanged. |
| Scope | Full tab bar, phased. Leaderboard stays a disabled tab with no page, exactly like the reference. |
| Mock data | Real data only. Level/progress derived from loyalty lifetime points via a configurable curve; last top-up from wallet history; reputation, bonus, achievements, fake session log dropped. |
| Promos | Member catalog of sellable credit products + wallet-funded `POST /portal/credits/purchase`. Online PSP top-up stays in `.ai/plans/chrono/active/member-credit-purchase`. |
| Realtime | None for members; manual Refresh like the reference. |

## Reference → agora mapping (what exists, what is new)

| Reference page | Data it needs | Agora today | Gap |
|---|---|---|---|
| Dashboard hero (8h 0m, status, today's usage) | credit minutes, active session, today's billable seconds | `GET /portal/credits/balance` (`totalRemainingMinutes`), `GET /portal/sessions/active` | today's usage |
| Wallet card | balance, last top-up | `GET /portal/wallet/balance`, `/history` | none (derive last top-up = newest `credit` tx) |
| Membership card | tier, level, progress, member since | loyalty is staff-only | `GET /portal/loyalty/me` + level curve |
| Premium store | sellable credit products | staff `GET /credits/products` | `GET /portal/credits/products` |
| Reservations | stations, my reservation, policy, restrictions, queue | all exist (`/portal/reservations/*`, `/public/stations`) | restyle only |
| Session | list + detail | active only | `GET /portal/sessions`, `/:id` |
| Connect | QR scan-to-start | `/q/[token]` page + `POST /public/qr/consume` | page that explains + links; no camera lib |
| Promos | store + purchase | staff `credit:sell` `purchaseCreditProduct()` | member purchase route + `GET /portal/promos` |
| Wallet / History | balance, wallet tx, credit ledger | all exist | merge client-side |
| Profile | name, phone, member since, application status | `GET /portal/members/me`, `/onboarding` | `PATCH /portal/members/me {phone}`, foundation `PATCH /portal/auth/me {name}` |
| Settings | change password, theme | none | foundation `POST /portal/auth/change-password` |

Facts verified this session:
- `export type AppType = typeof app` in `apps/chrono-api/src/app.ts:1120` covers the `/portal/*` mounts (lines 520–546), so `api.portal.wallet.balance.$get()` from `apps/chrono-web/src/lib/rpc.ts` is already typed. The six hand-rolled `lib/*-portal.ts` clients are redundant.
- `agora/member-auth` has no change-password or update-name route (`packages/agora/src/identity/member-auth/index.ts:398-680`).
- `agora/ui` lacks `Progress`, `Avatar`, `Skeleton`, `Tooltip`; has `DropdownMenu`, `Tabs`, `Separator`, `Sheet`, `StatTile`, `SiteHeader`, layout primitives.
- `apps/chrono-web/src/app/globals.css` already has `.premium-dots`, `.premium-gradient`, `.premium-text-gradient`, `.premium-glow`, `.premium-card-shadow` driven by `var(--primary)`.
- `LOYALTY_TIERS` with `minLifetimePoints` exists in `apps/chrono-api/src/modules/loyalty/service.ts:12`.
- `purchaseCreditProduct()` exists in `apps/chrono-api/src/modules/credit/service.ts:204`; `debitWallet()` in `modules/wallet/service.ts:117`.
- Redirect targets to update: `src/components/member-login-form.tsx:43` (`/portal`), `portal/sign-up/tenant-sign-up-form.tsx:37`, `portal/accept-invite/page.tsx:48`.
- 14 e2e specs reference `/portal` URLs (list in Phase 8).
- chrono-web has `typecheck` but no `lint` script.

## API-side design corrections (verified this session)

- `buildPaginationMeta` is duplicated in 13 places (10 staff `routes.ts` + 3 portal-routes + `routes/rpc.ts`). Move it to `packages/agora/src/core/contracts/core.ts` beside `paginationMetaSchema`; re-export from `routes/rpc.ts` for compatibility.
- `HttpError` has no error-code field; `onError` emits `{ error: message }`. Stable machine-readable errors go through the status code (422 = insufficient balance, 404 = not found/wrong tenant, 409 = product unavailable) — no new field on `HttpError`.
- `MemberContext` (`{tenantId, memberId, email, name}`) has no `createdAt`; `memberSince` must join `tenantMember.createdAt` under `withTenant`.
- `ChronoCreditPurchases` has no `performedByUserId` — a member-initiated purchase leaves it implicitly absent (there's no such column); mirrors `startedByUserId: null` for QR self-start sessions.
- Loyalty auto-earn is already live (wallet top-up, POS sale) so "lifetime points" reflects real spend today.
- Member Playwright specs live under `apps/chrono-web/e2e/tests/portal/`, not `member/` — new specs also go there even once pages move to `/member/*` URLs.
- `purchaseCreditProduct()` (`modules/credit/service.ts:204`) already takes an optional `performedByUserId` and runs inside the caller's open transaction — a member route can call it directly with that field omitted.
- `/portal/credits/balance` and `/portal/wallet/history` currently leak raw `$inferSelect` rows (`performedByUserId`, `walletId`, `shiftId`) — narrow to DTOs while those files are being touched anyway.

## Phase 0 — API: shared pagination helper (prep)

**Files:** `packages/agora/src/core/contracts/core.ts` (add `buildPaginationMeta`), `apps/chrono-api/src/routes/rpc.ts` (re-export), `apps/chrono-api/src/modules/{credit,wallet,inquiry}/portal-routes.ts` (import instead of local copy).
**Accept:** `pnpm typecheck` green; no local `buildPaginationMeta` left in portal-routes files.
**Out of scope:** the 10 staff `routes.ts` duplicates (separate mechanical chore, note only).

## Phase A — API: member loyalty read

**Files:** create `modules/loyalty/level.ts` (pure: `LOYALTY_TIERS`/`tierFor` moved here from `service.ts`, which re-exports them; `computeLevel(lifetimePoints, curve?)`, `LevelInfo`, `assertValidCurve`) + `level.test.ts`; create `modules/loyalty/portal-routes.ts` (`GET /me`, `GET /history`); update `modules/loyalty/contracts.ts` (portal DTOs, dropping `performedByUserId`/`accountId`/`tenantId`); mount `/portal/loyalty` in `app.ts`; add `test:loyalty-level` and `test:loyalty-concurrency` (orphaned test) scripts.
**Key design:** `computeLevel` and `tierFor` share one curve so the write path (points→tier) and the read path (level/progress) can never drift. `GET /me` returns `{ account: {...} | null, level: {current, nextTier, pointsToNext, progressPercent}, memberSince }` — never creates an account row on read.
**Accept:** no account → bronze/0%; after a staff earn crossing a threshold, `/me` reflects the new tier and correct `pointsToNext`; a different member/tenant gets `account: null` / 401 respectively.
**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api test:loyalty-level` · `test:e2e`. No schema change.
**Out of scope:** member redemption, tenant-configurable thresholds.

## Phase B — API: member session list, detail, today's usage

**Files:** update `modules/session/portal-routes.ts` (`GET /`, `GET /summary`, `GET /:id` — `/active` and `/summary` registered before `/:id`); create `modules/session/usage.ts` (pure `summarizeTodayUsage`, timezone-aware via `Intl.DateTimeFormat`) + `usage.test.ts`; update `modules/session/contracts.ts` (portal DTOs).
**Key design:** `GET /summary` returns `{ active, today: {billableSeconds, sessionCount, amountCharged, currency, timezone} }` computed from *ended* sessions only — never estimates cost for the still-running one server-side. `GET /:id` 404s on another member's or another tenant's session (no existence leak).
**Accept:** list is newest-first with station names; today's usage matches the sum of ended sessions started today in the branch's timezone; foreign id → 404.
**Verify:** `pnpm typecheck` · `test:session-usage` · `test:e2e`. No schema change.

## Phase C — API: member credit catalog + wallet-funded purchase

**Files:** update `modules/credit/portal-routes.ts` (`GET /products`, `POST /purchase`; narrow `/balance`, `/ledger` to DTOs); update `modules/credit/contracts.ts` (purchase/product/grant/ledger DTOs); update `modules/credit/service.ts` (`purchaseCreditProduct` gains optional `idempotencyKey`, returns `walletTransaction`); **recommended additive migration**: `chronoCreditPurchase.idempotencyKey` (nullable text) + partial unique index on `(tenantId, memberId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`; create `modules/credit/portal-purchase.concurrency.test.ts`; add a member-purchase rate limiter (10/15min per member) at the mount site in `app.ts`.
**Key design:** one `withTenant(tx => purchaseCreditProduct(tx, {tenantId, memberId, productId, idempotencyKey}))` reusing the exact staff transaction (product read → 404/409 → `debitWallet` FOR-UPDATE lock, 422 on insufficient balance → grant → ledger → purchase), with `performedByUserId` omitted for a member actor. A replay of the same idempotency key returns the existing purchase (200) instead of debiting twice. Audit after commit: `recordAudit({actorType: "member", action: "chronoCredit.purchased", ..., metadata: {channel: "portal"}})`.
**Accept:** catalog hides draft/archived products; purchase 201 grants minutes and debits the wallet visibly; replay with same key returns 200 + same purchase id, no second debit; empty wallet → 422, zero rows written; concurrent purchases with distinct keys → exactly one winner if funds only cover one; foreign tenant's product id → 404.
**Verify:** `pnpm typecheck` · `test:credit-concurrency` (still green) · `test:portal-purchase-concurrency` · if the migration lands: `db:generate`/`db:migrate` reviewed + `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅`.
**Out of scope:** online PSP top-up (stays in `.ai/plans/chrono/active/member-credit-purchase`), member-initiated void/refund.
**Fallback if the idempotency column is rejected:** skip the migration; rely on the rate limiter + a disabled purchase button client-side; drop the replay test case.

## Phase D — API: member promos read

**Files:** create `modules/promo/portal-routes.ts` (`GET /portal/promos`); update `modules/promo/contracts.ts` (`portalPromoDtoSchema`); mount in `app.ts`.
**Key design:** only `status:"active"`, in-window (`startsAt`/`endsAt`), redemption-cap-not-exhausted promos, safe fields only (`name, code, description, discountType, discountValue, minSpend, startsAt, endsAt, branchName`) — never counts or ids beyond the promo's own.
**Accept:** paused/expired/exhausted promos absent; branch-scoped promo shows branch name.
**Verify:** `pnpm typecheck` · `test:e2e`. No schema change. **Out of scope:** any redemption route (promos apply at POS/counter, not to credit-pack purchases).

## Phase E — API: wallet "last top-up" helper

**Files:** update `modules/wallet/contracts.ts` (`walletHistoryQuerySchema` gains optional `type` filter); update `modules/wallet/portal-routes.ts` (apply filter to count+rows; narrow to DTO dropping `walletId`/`performedByUserId`/`shiftId`).
**Key design:** no new endpoint — the dashboard's "last top-up" is `GET /portal/wallet/history?type=credit&pageSize=1`.
**Verify:** `pnpm typecheck` · `test:e2e`. No schema change.

## Phase F — API + foundation: profile & settings

**F1 (foundation, `packages/agora`):** update `core/contracts/member.ts` (`memberUpdateProfileSchema {name}`, `memberChangePasswordSchema {currentPassword, newPassword}`); update `identity/member-auth/index.ts` — `MemberContext` gains `customerId: string | null`; add `PATCH /me` (name update) and `POST /change-password` (verify current, rate-limited 5/15min, hash new, revoke **all** sessions including the caller's, mint a fresh cookie, delete outstanding reset tokens, audit); global-linked members (`customerId !== null`) get 409 on change-password (they authenticate via the global customer pool). Update `presentation/client/index.ts` (`memberAuth.updateProfile`, `memberAuth.changePassword`).
**F2 (chrono):** update `modules/member/contracts.ts` (`updateMyMemberProfileSchema {phone}`); update `modules/member/portal-routes.ts` (`PATCH /me` — 404 if no profile row yet, i.e. apply first).
**Accept:** name change visible on `/portal/auth/me`; wrong current password → 400, no session revoked; correct → 200, other sessions 401, caller's rotated cookie works; global-linked member → 409; phone patch 404 before apply, 200 after.
**Verify:** `pnpm typecheck` · `test:e2e`. No schema change.

## Phase G — API: mounting + typing

Add `.route("/portal/loyalty", loyaltyPortalRoutes())` and `.route("/portal/promos", promoPortalRoutes())` to `app.ts` right after the existing `/portal/reservations` mount. `export type AppType = typeof app` already covers the whole chain, so `hc<AppType>` in `apps/chrono-web/src/lib/rpc.ts` types every new route with no extra work.

## Phase H — API: test coverage

Add a "Chrono member portal" block to `apps/chrono-api/src/e2e/run.ts` covering every new route's happy path, the staff-cookie role gate (401), and cross-tenant isolation (404/401, never a leaked row) — the same block pattern as the existing customer-onboarding coverage. Add the Playwright specs in Phase 8 below (web section) once URLs land at `/member/*`. State explicitly: no new staff permissions, so `test:permissions` needs no changes.

---

## WEB PLAN

### Corrections to prior assumptions (verified)

- Reservations currently **polls every 15s**, not manual-refresh — Phase 2 replaces it with a Refresh button (+ one auto-reload when a hold countdown hits 00:00).
- `applicationStatus` enforces nothing anywhere in the API today; two existing specs have members reserve/pay without ever applying. Gating every tab per the reference would silently contradict shipped behavior and break `member-self-service.spec.ts`. **Decision: gate only Promos (store purchase) and Leaderboard (disabled)**, not Session/Connect/Reservations/Wallet/History. This is registry-driven so a future app can flag differently.
- `.ai/plans/chrono/active/member-credit-purchase` targets `/portal/credits`+`/portal/wallet` and PSP checkout — its web section is superseded here (Phase 6 updates its paths/notes; PSP top-up stays out of scope).
- `useMemberSession()` is an uncached one-shot hook — the shell fetches once and provides via context (`MemberAreaProvider`) rather than every page re-fetching.
- `chrono-web` has no `lint` script; verification is `typecheck` + `build` + the e2e spec.
- `hc<AppType>` already types `/portal/*` and `/public/*`; wallet/credit `history`/`ledger` currently return raw rows, so the new `lib/member/*` wrappers narrow with `Pick`.
- `.premium-dots` already exists in `apps/chrono-web/src/app/globals.css`; no new CSS utility needed for the shell background.

### A. URL, shell, gate

**Route group** (new, no collision risk unlike `/admin`): `apps/chrono-web/src/app/(member-area)/member/**` — `layout.tsx` (server: `getRequestTenant()` + `getPublicBranding()` + `getTenantLanding()` → `<MemberShell>`), `page.tsx` (dashboard), `reservations/`, `wallet/`, `history/`, `session/` (+ `[id]`), `connect/`, `promos/` (+ `[id]`), `profile/`, `settings/`, `inquiries/`.

`(member-portal)/portal/` keeps only the auth pages (`login`, `sign-up`, `forgot`, `reset`, `accept-invite` — their links are hardcoded in foundation emails) plus the apex global-customer home; `tenant-portal-layout.tsx` and `tenant-portal-home.tsx` are deleted once their logic moves.

**Redirects** — `next.config.ts` `redirects()` (not middleware, not client-side `location.replace`; mirrors the existing `/admin/*` `beforeFiles` host-conditioned rewrite pattern): `/portal → /member`, `/portal/reservations → /member/reservations`, `/portal/inquiries → /member/inquiries`, all `missing: notApex` (same host-pattern list already in the rewrite), `permanent: false`.

**Gate cascade** (`components/member/member-gate.tsx`, moved from `tenant-portal-layout.tsx`, not duplicated):
1. Sessions pending → skeleton shell.
2. Neither member nor global customer → `/login?next=<path>` (deep links survive).
3. Global customer only → `ApplyForTenantPrompt` (copy unchanged, asserted by an existing spec).
4. Member → one `GET /portal/members/me` → `MemberAreaProvider` → header + nav + `RouteGate`.
5. `RouteGate`: route flagged `requiresApproval` and not approved → `ApprovalRequiredCard` (copy varies by `applicationStatus`); else render.

### B. Shell components (`apps/chrono-web/src/components/member/`)

- `member-nav.config.ts` — the registry (no JSX): `MEMBER_NAV: MemberNavEntry[]` with `{key, label, shortLabel, href, icon, requiresApproval, disabled?, exact?, placements}` for all 10 tabs + inquiries; `matchMemberNav(pathname)` does prefix matching (fixes the reference's bug where `/member/promos/[id]` highlights nothing); `MEMBER_USER_MENU` derives from `placements.includes("menu")`; `MEMBER_DASHBOARD_CARDS` order.
- `member-shell.tsx`, `member-gate.tsx`, `member-area-context.tsx` (`useMemberArea()` → `{member, profile, approved, refreshProfile}`), `apply-for-tenant-prompt.tsx`.
- `member-header.tsx` — reuses `TenantHeader` (gains `surface?: "landing"|"member"` → sticky/opaque instead of fixed/transparent when `"member"`, plus an `actions` override slot) with `MemberUserMenu` replacing the "Member login" CTA.
- `member-user-menu.tsx` — built on a new foundation `IdentityMenu` primitive (auth-agnostic; `agora/ui`'s existing `UserMenu` is Better-Auth/staff-bound, left untouched).
- `member-nav.tsx` — desktop tab bar (`NavTabs` primitive, sticky under the header, horizontal-scroll for 10 items) + `MemberBottomNav` (`BottomNav` primitive, `< md`, 5 shortlabel items).
- `member-page-header.tsx`, `refresh-button.tsx`, `member-typography.tsx` (shared `Eyebrow`/`TrackedLabel` string constants, sourced from the same `components/landing/tokens.ts` the landing sections already use, so the two surfaces can't drift), `status-pill.tsx` (station/session status tones, same `STATION_TONE` map moved to `tokens.ts`).

`TenantHeader`/`TenantFooter` (`components/landing/marketing-chrome.tsx`) gain the `surface`/`actions`/`mobileNavExtra` and `accountHref`/`accountLabel` props described above — additive, not breaking existing landing usage.

### C. New `agora/ui` primitives (foundation, companion plan `.ai/plans/agora/active/member-shell-primitives/README.md`)

| Component | Shape | Notes |
|---|---|---|
| `Progress` | Radix `@radix-ui/react-progress` (new dep, matches sibling Radix pins) | shadcn-standard `components/progress.tsx` |
| `Skeleton` | pure Tailwind `animate-pulse` div | `components/skeleton.tsx` |
| `Avatar` | initials-only, no dep | `components/custom/avatar.tsx` |
| `NavTabs` | route-nav tab strip (Link-based, not Radix Tabs) | `components/custom/nav-tabs.tsx` |
| `BottomNav` | fixed mobile bar, same item shape as `NavTabs` | `components/custom/bottom-nav.tsx` |
| `IdentityMenu` | auth-agnostic avatar+name dropdown, `onSignOut` callback | `components/custom/identity-menu.tsx` |

All exported from `packages/agora/src/presentation/ui/index.ts`. `PlaytimeHero`, `StatusPill`, `MemberPageHeader`, `RefreshButton` stay chrono-local — member-domain composition, not generic to every multi-tenant app.

### D. Data layer

New `apps/chrono-web/src/lib/member/` — typed wrappers over `api.portal.*` (the existing `hc<AppType>` client), replacing the six hand-rolled `*-portal.ts` files module by module as each phase lands (`member-application.ts`, `wallet-portal.ts`, `credits-portal.ts`, `session-portal.ts` retire in Phase 1; `reservations-portal.ts` in Phase 2; `inquiries-portal.ts` in Phase 7). Files: `client.ts` (shared `unwrap<T>` + `Ok<T>` type helper), `paths.ts`, `format.ts`, `wallet.ts`, `credits.ts`, `session.ts`, `membership.ts`, `loyalty.ts`, `account.ts`, `reservations.ts`, `promos.ts`, `inquiries.ts`.

Loading/empty/error contract: `Skeleton` while first load is pending, `CenteredMessage` only for whole-page empty states, `toast.error` on failed mutations, manual `RefreshButton` — no polling anywhere in the member area.

### E. Per-page breakdown (real data only, per the decision)

- **Dashboard** — `PlaytimeHero` (available minutes, status pill, today's usage, CTAs), `ActiveReservationBanner` (only when a reservation exists), `MembershipStatusCard` (existing onboarding copy, verbatim), `WalletCard` (balance + last top-up = newest `type:"credit"` history row + Details link), `MembershipCard` (tier badge, derived level, `Progress` bar, points-to-next, member since — no bonus/reputation/achievements), `PremiumStore` (top 3 real sellable credit products).
- **Reservations** — move existing page/logic; replace the 15s poll with `RefreshButton`; re-skin into `station-grid.tsx`/`station-card.tsx` (status pill, SELECT/SELECTED footer) + a sticky `reservation-panel.tsx` (wallet+minutes chip, empty prompt "Select a station to reserve it or join its queue", booking form, active/queue/hold state, cancel dialog).
- **Wallet** — balance card + paginated wallet-history table (server-side pagination per `.ai/rules/pagination.md`).
- **History** — tabbed (Wallet / Credits / Sessions), each independently paginated — no client-side merge across pages (a true unified feed needs a new `GET /portal/activity` API endpoint, noted as a follow-up, not planned here).
- **Session** — active-session card, paginated list, `[id]` detail (404 on another member's session, no existence leak).
- **Connect** — three-step explainer reusing the existing `/q/[token]` scan-to-start flow; camera scanning itself is out of scope (no cross-browser dependency-free path; the phone's native camera app is the real path).
- **Promos** — product grid + `[id]` detail + purchase dialog (balance preview, disabled when insufficient, success toast with new balance) calling the new wallet-funded purchase route; running-promos list is informational only.
- **Profile** — name/phone form, membership details, member id (full id, not a fabricated short code).
- **Settings** — change-password form, theme preference, sign-out, help link to inquiries.

### F. Redirect/entry points to update

`member-login-form.tsx`, `tenant-sign-up-form.tsx`, `accept-invite/page.tsx`, `global-portal-home.tsx` success redirects → `/member`; `portal/layout.tsx`/`page.tsx` drop their tenant branch; `next.config.ts` redirects (above); `TenantStations`/`TenantCta` "Reserve a seat"/"Sign in" links → `/login?next=/member/reservations`; `q/[token]` success state gets a "Go to my session" link.

### G. E2E

New `apps/chrono-web/e2e/tests/member/` folder: `shell.spec.ts` (nav, redirects, user menu, role gate, deep-link, cross-tenant isolation), `dashboard.spec.ts`, `wallet-history.spec.ts`, `session.spec.ts`, `profile-settings.spec.ts`, `promos.spec.ts` — each with happy path + role gate + cross-tenant isolation per `.ai/rules/e2e-testing.md`. ~11 existing specs need their `/portal` URL/waitForURL expectations updated to `/member` (`reservations/member-self-service`, `portal/customer-onboarding`, `inquiries/inquiries`, `global-customers/apply-for-tenant`, `auth/tenant-login-paths`, `members/members`, `members/invite-customer`, `wallet/wallet`, `credits/credits`, `sessions/sessions`, `loyalty/loyalty`, `qr/qr`, `pos/pos`, `reconciliation/expected-cash-computation`).

### H. Docs

Update `apps/chrono-api/AGENTS.md` Surfaces table (`/member/*` replaces `/portal/*` as the tenant member area; `/portal/{login,sign-up,forgot,reset,accept-invite}` stay); create the plan at `.ai/plans/chrono/active/member-area/README.md`; update `.ai/plans/chrono/active/member-credit-purchase/README.md`'s web section to point at `/member/promos`/`/member/wallet`.

## Execution phases (merged, commit each separately)

0. **Foundation primitives** — `Progress`, `Skeleton`, `Avatar`, `NavTabs`, `BottomNav`, `IdentityMenu` in `packages/agora/src/presentation/ui/`. Verify: `pnpm typecheck`.
1. **API prep** — shared `buildPaginationMeta` (API Phase 0).
2. **Shell + dashboard** — route group, gate, header/nav, registry, redirects, dashboard cards; API Phases A (loyalty), E (wallet last-top-up); retire 4 of the 6 hand-rolled clients. Verify: `pnpm typecheck`, `pnpm --filter @agora/chrono-web build`, `shell.spec.ts` + `dashboard.spec.ts`, update the ~11 existing specs' URLs.
3. **Reservations** — move + re-skin, drop the poll. Verify: `member-self-service.spec.ts` updated + passing.
4. **Wallet + History** — API Phase E already landed; web pages + tabs. Verify: `wallet-history.spec.ts`.
5. **Session + Connect** — API Phase B; web pages; `/q/[token]` link. Verify: `session.spec.ts`.
6. **Profile + Settings** — API Phase F (foundation `PATCH /portal/auth/me`, `POST /portal/auth/change-password`; chrono `PATCH /portal/members/me`); web forms. Verify: `profile-settings.spec.ts`.
7. **Promos (store)** — API Phase C (catalog + wallet-funded purchase, the largest phase; optional idempotency migration) and Phase D (promos read); web catalog/detail/purchase. Verify: `rls:proof` if the migration lands, `promos.spec.ts`.
8. **Cleanup** — retire remaining hand-rolled clients, docs, move plan to archive.

## Out of scope (whole plan)

Online PSP top-up (stays with `.ai/plans/chrono/active/member-credit-purchase`), member realtime/live station or session pushes, camera-based QR scanning, sign-out-everywhere, a fabricated short member code, tenant-configurable loyalty thresholds, promo redemption by members, approval enforcement beyond the two flagged tabs.

## Verification (whole plan)

Per phase: `pnpm typecheck` (root or `--filter @agora/chrono-api` / `--filter @agora/chrono-web` / `--filter agora` as touched) · `pnpm --filter @agora/chrono-web build` · the new Playwright spec(s) with `pnpm dev` running · `pnpm --filter @agora/chrono-api test:e2e` for the offline API suite · `pnpm --filter @agora/chrono-api rls:proof` only if Phase 7's optional migration lands · relevant `test:*-concurrency` scripts for Phase 7.

