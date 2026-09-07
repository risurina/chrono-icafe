# Member profile — avatar upload + security session log (lounge/branch)

**App:** chrono
**Depends on:** `.ai/plans/agora/draft/member-session-log-and-avatar/README.md`
(foundation schema + `/portal/auth/{sessions,me/avatar/*}` routes +
`memberAuth` client methods) — must be implemented and migrated first. This
plan only adds Chrono-specific UI and one Chrono-specific read (recent
branch).
**Sessions:**
- Planning: agora-a9 [10bb99]
- Audit: (unclaimed)
- Implementation: (unclaimed)

## Context

Today's `/member/profile` page
(`apps/chrono-web/src/app/(tenant-member)/player/profile/page.tsx`, serving
the public URL `/member/profile` on a tenant host — see
`.ai/plans/chrono/archive/member-player-route-rename/README.md`) already has:
name edit, password change/set, membership status/member-code/branch-name(*)/
member-since, quick actions, and a "message the branch" CTA. It has **no**
avatar upload and **no** login/security session log.

(*) Note: the existing "Branch" info tile
(`page.tsx:326`, `branchName` state) is actually the **tenant's** display
name (fetched from `/public/tenant` + `/public/branding`), not a
`ChronoBranches` row — it's mislabeled relative to this plan's real "branch"
concept below. This plan does not fix that existing tile (out of scope); it
adds a genuinely new, separately-labeled "Recent branch" field so the two are
not confused.

### The "lounge" and "branch" requirement — design decision

The developer asked for each session-log entry to show "lounge" (Chrono's
term for a tenant/venue business) and "branch" (a physical `ChronoBranches`
location within that venue). Verified by direct research (2026-09-07):

- **"Lounge" is trivial** — a session belongs to exactly one tenant
  (`tenantId` on `tenantMemberSession`), and the page is already tenant-host-
  scoped, so "lounge" for every row is just the current tenant's display
  name (already resolved by this page as `branchName`/by `member/layout.tsx`
  more generally). No new tracking needed.
- **"Branch" is NOT derivable from a login at all.** Confirmed by direct
  schema reads: `tenantMemberSession` has no branch column and no request
  path today lets a member indicate "which branch am I at" when signing in
  (`applyForMembershipSchema` takes only an optional `phone`; no
  `primaryBranch`/`homeBranch`/`defaultBranch` concept exists anywhere in the
  repo — confirmed by grep). Seed data (`apps/chrono-api/src/seed.ts:263-336`)
  proves multi-branch tenants are a real, exercised case (e.g. `acme` and
  `gaming` each seed 2 branches: `main` + `vip`), so "just show the tenant's
  only branch" is not a safe assumption either.
  The only place `memberId` and `branchId` genuinely co-occur today is
  **activity-level**: `chronoReservation`
  (`apps/chrono-api/src/modules/reservation/schema.ts:16,31`) and
  `chronoSession` (`apps/chrono-api/src/modules/session/schema.ts:18,30`) —
  a booking or a play session, never a login.
  **Decision (the recommended, non-speculative option — flag to the
  developer if a per-login branch is actually wanted instead):** do not
  fabricate a per-session-log-row branch. Instead, add one **account-level**
  "Recent branch" field — the branch of the member's most recent
  `chronoReservation` or `chronoSession` row (whichever is more recent),
  shown once in the Membership Details card, alongside the existing (now
  correctly labeled) "Lounge" field. This is honest (derived from real
  activity, never invented) and needs no new schema. If the developer instead
  wants a true per-login branch, that requires adding branch selection to the
  sign-in flow itself — a materially bigger, separate change, deliberately
  not built here without being asked for explicitly.

## Pass 1 — Workflow

- **Who:** an approved or pending tenant member, on their own `/member/
  profile` page. No staff/admin involvement, no role gate beyond "member is
  signed in to this tenant" (member-only actions on member-only rows).
- **Workflow:** member uploads/replaces an avatar; member reviews their
  active login sessions (device, IP, last-seen, "this device") with the
  lounge/branch context, and can revoke a session that isn't the one they're
  using.
- **Failure cases:** unauthenticated (existing `MemberGate` redirect,
  unaffected); a member on tenant A must never see or revoke a session
  belonging to a member on tenant B, or another member's session on the
  *same* tenant (both already enforced server-side by the foundation plan —
  this page must not add any client-side-only trust); an oversized/invalid
  image upload fails with a toast, old avatar stays; revoking the current
  session must sign the member out and redirect to login (mirrors the
  existing password-change "signed out of your other sessions" toast copy at
  `page.tsx:257-259`).
- **No audit/notification needed** — self-service member surface, no staff
  visibility.

## Pass 2 — Technical plan

- **Files touched:**
  `apps/chrono-web/src/app/(tenant-member)/player/profile/page.tsx`,
  a new `apps/chrono-web/src/components/member/avatar-upload.tsx` (client
  island — file picker + preview + upload progress), a new
  `apps/chrono-api/src/modules/member/portal-routes.ts` addition (the
  "recent branch" read, since it's Chrono business logic over
  `chronoReservation`/`chronoSession`, per `.ai/rules/architecture.md`'s
  "specific to one business's product" rule — this does **not** belong in
  `packages/agora`), matching contract in
  `apps/chrono-api/src/modules/member/contracts.ts`, a new e2e spec.
- **Boundaries:** UI + one Chrono-owned business-logic read in
  `apps/chrono-api`/`apps/chrono-web`; everything else (session list/revoke,
  avatar sign/confirm) is consumed unchanged from the foundation plan via
  `memberAuth` (`apps/chrono-web/src/lib/member-client.ts`, a pure re-export
  — no changes needed there).
- **Tenant/RLS impact:** the new "recent branch" read is a `withTenant`
  select scoped to `c.var.member.memberId` — no new table, no
  `APP_TENANT_TABLES` change (both `ChronoReservations` and `ChronoSessions`
  are already registered).
- **Out of scope:** fixing the existing mislabeled "Branch" tile (noted
  above, left alone); per-login branch capture (requires a sign-in-flow
  change, not requested); avatar cropping; linking to the existing
  gaming/rental session history at `player/session*` (developer explicitly
  said this feature is *not* about station/reservation history — separate
  from this "security session log").

## Phase 1 — Recent-branch read (Chrono API)

**Files to update:**
- `apps/chrono-api/src/modules/member/contracts.ts`
- `apps/chrono-api/src/modules/member/portal-routes.ts`

**Step-by-step tasks:**
1. In `contracts.ts`, add:
   ```ts
   export const recentBranchSchema = z.object({
     branchId: z.string(),
     branchName: z.string(),
     lastActivityAt: z.string(),
   }).nullable();
   ```
2. In `portal-routes.ts`, add `GET /me/recent-branch` (alongside the existing
   `.get("/me")`/`.get("/me/onboarding")` — same `memberMiddleware()` gate
   already applied `.use("*", ...)` at the top of this router). Implementation:
   a `withTenant` query that, for `c.var.member.memberId`, does a `UNION` (or
   two separate queries compared in code — whichever is simpler given
   Drizzle's query builder) over the most recent `chronoReservation` row and
   the most recent `chronoSession` row for that member, each joined to
   `chronoBranch` for the name, picks whichever has the later timestamp
   (`createdAt`/`startedAt` — check each schema's actual timestamp column
   name first), and returns `null` if the member has no reservation/session
   history yet (a new member — this must not error, just render "—" on the
   page).
3. No permission gate beyond `memberMiddleware()` — a member reading their
   own derived activity needs no `requirePermission` call (same posture as
   the existing `.get("/me")` in this file).

**Acceptance criteria:**
- `GET /portal/members/me/recent-branch` (confirm the actual mount prefix by
  re-reading how `portal-routes.ts` is mounted in `apps/chrono-api/src/
  app.ts` before wiring the client call in Phase 2 — the foundation research
  found it mounted at `/portal/members`, distinct from `/portal/auth`) returns
  the member's own most recent branch, or `null` for a member with no
  activity yet.
- Never returns another member's data — `memberId` always from
  `c.var.member`, never client input.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` if a Chrono-specific proof
  target exists, else the workspace `rls:proof` — confirm the exact filter
  name from `package.json` before running.

**Out of scope:** caching/memoizing this read; showing branch history
(only the single most-recent).

**Execution start point:** `apps/chrono-api/src/modules/member/
portal-routes.ts`, after the existing `.get("/me/onboarding")` handler.

---

## Phase 2 — Avatar upload UI

**Files to update:**
- `apps/chrono-web/src/components/member/avatar-upload.tsx` (new)
- `apps/chrono-web/src/app/(tenant-member)/player/profile/page.tsx`

**Step-by-step tasks:**
1. Build `AvatarUploadField` as a small client component using `agora/ui`
   primitives only (`Button`, `Input` type="file", or a styled label wrapping
   a hidden file input — check `agora/ui` for an existing file-input pattern
   first; if none exists, keep this minimal rather than inventing a new
   primitive, per `.ai/rules/component-first-ui.md`'s "if a needed primitive
   does not exist, add it to `packages/agora/src/presentation/ui` first" —
   only add a shared primitive if this genuinely needs one beyond a plain
   file `<Input>`).
2. On file select: client-side guard on size/type (mirror whatever
   `MAX_ASSET_BYTES`/allowed types the foundation's `signUpload` enforces —
   read `packages/agora/src/core/server/providers/storage/sniff.ts` for the
   exact allowed types/size so the client-side check matches the server's,
   not a guessed value) → call `memberAuth.getAvatarUploadTicket(file.type)`
   → PUT/POST the file bytes to the returned ticket per its `method`/`fields`
   (follow whatever upload-ticket-consumption pattern already exists
   elsewhere in `apps/chrono-web` for the staff-side file upload, if one
   exists client-side, or write the minimal fetch needed for the ticket
   shape) → `memberAuth.confirmAvatar(ticket.key)` → on success, call
   `refreshProfile()` (already used elsewhere on this page) so the header's
   avatar (if the shared header renders one) picks it up, and `toast.success`.
3. Wire `AvatarUploadField` into the profile page's Hero card
   (`page.tsx:280-321`), replacing or augmenting the existing `User` icon
   badge with the member's current avatar (`member?.image`) when set, falling
   back to the existing icon badge when not.

**Acceptance criteria:**
- A member can pick an image file, see it uploaded, and see it reflected as
  their avatar without a full page reload (except where `nameChanged`
  already forces one elsewhere in this file — avatar-only updates should not
  need a reload).
- Oversized/wrong-type files are rejected client-side with a toast before any
  network call; a server-side rejection (e.g. a race where the client check
  passed but the server's differs) also surfaces as a toast, not a silent
  failure.
- No raw HTML file input styled ad-hoc outside `agora/ui` conventions
  (`.ai/rules/component-first-ui.md`).

**Verification commands:**
- `pnpm --filter @agora/chrono-web build`
- Manual browser pass (`pnpm dev`, `STORAGE_PROVIDER=local`): sign in as a
  test member on a tenant host, upload an avatar, confirm it persists across
  a page reload.

**Out of scope:** avatar cropping/aspect-ratio enforcement; removing an
avatar (revert to default) — add only if the developer asks; this phase does
not touch the Hero markup's existing status/member-code logic beyond
inserting the avatar image.

**Execution start point:** `apps/chrono-web/src/app/(tenant-member)/player/
profile/page.tsx`, the Hero `Card` block (line 280).

---

## Phase 3 — Security session log UI

**Files to update:**
- `apps/chrono-web/src/app/(tenant-member)/player/profile/page.tsx`
- possibly a new `apps/chrono-web/src/lib/member/recent-branch.ts` (thin
  fetch wrapper for Phase 1's new route, following the existing
  `apps/chrono-web/src/lib/member/loyalty.ts`'s `getMyLoyalty()` pattern
  already used on this same page)

**Step-by-step tasks:**
1. Add `getMyRecentBranch()` to `lib/member/recent-branch.ts`, mirroring
   `getMyLoyalty()`'s exact shape (same `tenantFetch`/error-handling
   convention already used elsewhere on this page).
2. Add a new "Security" card to the profile page (below the existing "Edit
   Profile Details" card, in the same `Grid` — either its own row or added to
   the right column stack, whichever reads better given existing card
   heights) that:
   - On mount, calls `memberAuth.listSessions()` and `getMyRecentBranch()` (in
     parallel, mirroring the existing `Promise.all` pattern already used for
     tenant/branding fetches at `page.tsx:191-194`).
   - Renders one row per session: relative last-seen time (reuse
     `formatDate`/add a `formatRelative` helper if the existing `lib/member/
     format.ts` doesn't already have one — check first), a short parsed
     device/browser label from `userAgent` (a small inline parse — e.g.
     "Chrome on macOS" — no new dependency; keep it simple string matching,
     not a full UA-parsing library, since this is a display nicety not a
     security control), the `ipAddress` (or "—" if null, for pre-migration
     rows), a "This device" badge when `isCurrent`, and a "Log out" button
     per row calling `memberAuth.revokeSession(id)`.
   - Shows "Lounge: {branchName from existing tenant fetch}" and
     "Recent branch: {recentBranch?.branchName ?? "—"}" once, above the
     session rows (account-level, not per-row — per the Pass 1 design
     decision).
   - On revoke: `toast.success`, remove the row from local state; if the
     response says `signedOutSelf: true`, redirect to `/member/login`
     (mirror however the existing sign-out flow already redirects elsewhere
     in this app — reuse that, don't invent a new redirect path).
3. Do not touch the existing password-change section or Quick Actions —
   this is purely additive.

**Acceptance criteria:**
- The Security card lists the signed-in member's own sessions only, with a
  working "this device" indicator and working per-row revoke.
- Revoking a non-current session removes it from the list without signing
  the member out; revoking the current session signs them out and redirects.
- Lounge/Recent-branch context renders honestly — "—" for a member with no
  reservation/session activity yet, never a fabricated branch name.

**Verification commands:**
- `pnpm --filter @agora/chrono-web build`
- Manual browser pass: open two browser sessions as the same test member
  (e.g. a normal window + an incognito window), confirm both show up in the
  list from either one, revoke the *other* one from the first window, confirm
  it disappears and that session's page 401s on its next request.

**Out of scope:** live-updating the list on another tab's revoke (poll or
refetch, not push); showing more than the caller's own tenant's sessions
(there is only ever one tenant's worth for a `tenantMember`-scoped session
anyway).

**Execution start point:** `apps/chrono-web/src/app/(tenant-member)/player/
profile/page.tsx`, after the "Edit Profile Details" `Card` (line 410).

---

## Phase 4 — E2E spec

**Files to update:**
- new `apps/chrono-web/e2e/tests/member/profile-security-and-avatar.spec.ts`

**Step-by-step tasks:**
1. Cover, per `.ai/rules/e2e-testing.md`: (a) happy path — sign in as a
   member, upload an avatar, see it reflected; open a second session, see it
   in the list, revoke it, confirm it's gone; (b) ownership gate — using two
   distinct member accounts in the **same** tenant, confirm member A's
   `GET /portal/auth/sessions` never contains member B's session and
   member A cannot revoke member B's session id (expect 404, not a silent
   no-op or 200); (c) cross-tenant isolation — a member in tenant A's session
   list/avatar must never be reachable from tenant B's host.
2. Use `@faker-js/faker` per `.ai/rules/e2e-testing.md` for all test data
   (emails, names) — no hand-rolled unique suffixes.
3. Follow this app's existing member e2e spec structure (look at
   `apps/chrono-web/e2e/tests/member/shell.spec.ts` or similar, referenced in
   the route-rename plan, for the existing `test.describe` grouping
   convention before writing this one).

**Acceptance criteria:**
- All three scenarios pass locally.
- The spec fails (not skips) if the ownership gate is ever removed —
  i.e. it actually asserts the 404, not just "no crash".

**Verification commands:**
- `pnpm --filter @agora/chrono-web test:e2e` (or whatever the actual e2e
  script name is — confirm from `package.json` before running; per
  `.ai/rules/rbac.md`'s testing note, this Playwright suite needs `pnpm dev`
  running first and no `apps/agora-api/.env` present).

**Out of scope:** load/perf testing of the session list under many sessions.

**Execution start point:** copy the nearest existing member e2e spec's
`test.describe` skeleton as a starting point.

---

## After this plan

Move from `draft/` → `ready/` on developer acceptance, then → `in-progress/`
when Phase 1 is claimed and committed. Do not start Phase 1 here until the
foundation plan's migration has actually run locally (Phase 1–2 of that
plan) — Phase 1 of *this* plan only needs `chronoReservation`/`chronoSession`
(already landed, unrelated to the foundation plan), so it could in principle
start independently, but Phases 2–3 hard-depend on the foundation's new
routes/client methods existing.
