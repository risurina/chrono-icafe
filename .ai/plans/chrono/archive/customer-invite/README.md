# Chrono — Invite a Customer

**Status:** Done — implemented and verified.

- Phase 1 (foundation `member-auth` mechanism) — complete.
- Phase 2 (Chrono API route + permissions) — complete.
- Phase 3 (portal accept-invite page + dashboard Invite dialog) — complete.
- Phase 4 (e2e spec, `apps/chrono-web/e2e/tests/members/invite-customer.spec.ts`)
  — complete; all 3 scenarios (happy path, role gate, cross-tenant isolation)
  pass against real dev servers.
- Verification: `pnpm typecheck` (workspace), `pnpm --filter @agora/chrono-api
  rls:proof` (PASS, non-vacuous), `pnpm --filter @agora/chrono-api
  test:permissions` (399/399, including the `memberProfile:invite` gate),
  full Playwright run of the e2e spec (3/3 passed).

## Follow-on bugs found and fixed during verification

All four were discovered while getting the Phase 4 e2e spec to actually run
end to end; none were pre-known when the plan was written.

1. **Real bug in this feature (Phase 3):** `apps/chrono-web/src/app/
   (member-portal)/portal/tenant-portal-layout.tsx`'s `PUBLIC` allowlist never
   included `/portal/accept-invite`, so the layout's own auth guard redirected
   every unauthenticated invitee straight to `/portal/login` before they could
   see the "set your password" form — the invite link was completely
   non-functional. Fixed by adding the route to `PUBLIC`.
2. **Pre-existing, unrelated to this feature:** `apps/chrono-web/src/app/
   globals.css` and `apps/agora-web/src/app/globals.css` both had a stale
   Tailwind `@source` path (`packages/agora/src/ui`, from before an internal
   `packages/agora/src` reorg into domain groups — see commit `03affe1`) that
   no longer resolves to `packages/agora/src/presentation/ui`. Tailwind
   silently dropped every utility class used only inside the shared `agora/ui`
   library — in particular `Dialog`'s centering classes (`top-1/2 left-1/2
   -translate-x-1/2 -translate-y-1/2`) — so every `Dialog` in both
   `apps/agora-web` and `apps/chrono-web` rendered off-screen. This blocks any
   Dialog-based e2e flow, not just this one. Fixed by correcting the path in
   both apps' `globals.css`.
3. **Test-only, this plan's own spec:** the sign-up helper referenced
   pre-rebrand field labels ("Workspace name" / "create workspace") that no
   longer match the current `/sign-up` page copy ("Business name" / "Business
   URL" / "Create business") — a drift affecting the shared `signUp()` helper
   pattern copied across roughly 65 other e2e spec files in
   `apps/chrono-web/e2e/tests/`, not something specific to this plan. Fixed
   locally in this spec only; the other ~65 files are unaffected by this plan
   and were left as-is.
4. **Test-only, this plan's own spec:** two case-sensitivity bugs (the emailed
   invite link is searched for by exact string match against the server's
   always-lowercased recipient address; a table-row locator matched the
   original mixed-case faker email against the server's lowercased stored
   value) and a Playwright strict-mode violation (sonner renders its error
   toast twice in the DOM — a visible copy plus an accessibility-live-region
   duplicate — so a text locator needed `.first()`). All fixed in this spec.

## Context

`/dashboard/members` (`apps/chrono-web/src/app/dashboard/members/page.tsx`) today only
lists customers who arrived on their own — self-signup on `/portal` or a global
customer's self-apply — plus staff can approve/reject them. There is no way for staff to
proactively bring a customer in. The closest existing mechanism, `POST /rpc/customers`
(`apps/chrono-api/src/routes/rpc.ts:1212`), lets an admin type a temp password for a new
customer but **never emails it** — the customer has no way to actually get in.

We're adding a real invite flow: staff enters a name + email, the customer gets an email
with a link, and sets their own password to activate the account — auto-approved
(`ChronoMemberProfiles.applicationStatus = "approved"` immediately), matching the staff
Better-Auth invite flow's shape (`packages/agora/src/invites/*`) but for the *customer*
(`tenantMember`) pool instead.

## Where this lives (foundation vs. Chrono)

Per `.ai/rules/architecture.md` ("Where a feature belongs") and
`.ai/rules/business-app.md`: the *mechanism* — minting a single-use invite token against
`tenantMember`/`tenantMemberToken`, emailing it, and accepting it to set a password — is
generic to any multi-tenant app with the foundation's customer pool, exactly like
`agora/member-auth`'s existing forgot/reset flow it will sit beside. It goes in
**`packages/agora/src/member-auth/index.ts`** (foundation), not Chrono.

The *trigger* — who may invite, and what happens on the Chrono side (creating the
`ChronoMemberProfiles` row as `approved`) — is Chrono-owned, gated on Chrono's own
`memberProfile` permission resource, exactly like `approve`/`reject` already are.

This mirrors the existing split: `agora/invites` (foundation mechanism) +
`apps/chrono-api`'s own permission gate on top, for the *staff* invite flow.

## Design

### 1. Foundation: `packages/agora/src/member-auth/index.ts`

No schema migration needed — `tenantMemberToken.purpose` is a free-text column
(`packages/agora/src/db/schema/tenant.ts:224`, currently `'reset' | 'verify'` by
comment only, not an enum). Add `'invite'` as a third value, updating the comment.

**`inviteTenantMember(opts: { tenantId: string; tenantSlug: string; email: string; name: string }): Promise<{ member: { id: string; email: string; name: string }; resent: boolean }>`**
(new exported function, placed after `hashPassword`/`sha256` near the other helpers)

- Look up an existing `tenantMember` row for `(tenantId, email)`.
- **No existing row** → insert one now with a deliberately-unmatchable placeholder
  passwordHash, exact pattern from `customer-auth/index.ts:381`:
  `` `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}` ``
  (comment: "Login for this row happens only after accept-invite sets a real password —
  this hash matches nothing.") `status: "active"`. Returns `resent: false`.
- **Existing row, still on a placeholder hash** (i.e. an outstanding, unaccepted invite —
  detected by checking for an unconsumed `tenantMemberToken` row with
  `purpose: "invite"` and `memberId` = that row's id, not by parsing the hash) → this is
  a re-invite: mint a fresh token (invalidating the old one), keep the row as-is.
  Returns `resent: true`.
- **Existing row with a real, accepted password** → throw
  `HttpError(409, "A customer with that email already exists")`.
- Either way (new or resent), mint `{ token, tokenHash }` via the same
  `randomBytes(32).toString("base64url")` + `sha256()` pattern already in this file
  (mirrors `forgot`'s token mint at `index.ts:428-437`), delete any prior `purpose:
  "invite"` tokens for that member first (single active invite per member), insert the
  new `tenantMemberToken` row (`purpose: "invite"`, 7-day `expiresAt` — matching the
  staff invite's own 7-day window in `invites/routes.ts`), then send the invite email
  (new `sendMemberInviteEmail`, modeled on this file's private `sendMemberEmail` +
  `portalResetUrl`, building an accept URL
  `` `${scheme}://${tenantSlug}.${appDomain}/portal/accept-invite?token=...` `` — a new
  URL builder `portalAcceptInviteUrl`, sibling to `portalResetUrl` at `index.ts:76-82`).
  Email send is **not** best-effort-swallowed here — the caller (Chrono's route) decides
  how to surface a send failure, same division of responsibility as
  `invites/routes.ts`'s own `emailSent: false` pattern.

**`POST /accept-invite` route**, added to `createMemberAuthRoutes()` (`index.ts:295`),
alongside `/reset`:

- Validates a new `memberAcceptInviteSchema` (`{ token: string; password: string }`,
  added to `packages/agora/src/contracts` next to `memberResetSchema`).
- Looks up `tenantMemberToken` by `tokenHash` + `purpose: "invite"`; 400 if missing or
  expired (mirrors `/reset` at `index.ts:471-485`).
- Sets the real `passwordHash` on the row, deletes every `purpose: "invite"` token for
  that member (single-use), and — unlike `/reset` — **creates a session and writes the
  cookie** (`createSession` + `writeCookie`, already in this file) so the customer lands
  signed in, matching the "auto-approved, ready to go" decision. Returns
  `{ member: toMember(row) }`.

### 2. Contracts (`packages/agora`)

- `packages/agora/src/contracts` (wherever `memberResetSchema` lives): add
  `memberAcceptInviteSchema = z.object({ token: z.string().min(1), password: z.string().min(8) })`.
- `apps/chrono-api/src/modules/member/contracts.ts`: add
  `inviteMemberSchema = z.object({ email: z.string().email(), name: z.string().min(1).max(200) })`.

### 3. Chrono: `apps/chrono-api/src/modules/member/routes.ts`

Add `POST /invite` to `memberProfileRoutes()` (mounted at `/member-profiles` per
`rpc.ts:1157`, so the full path is `/rpc/member-profiles/invite`):

- `requirePermission(c.var.tenant.permissions, { memberProfile: ["invite"] })` — new
  action.
- `zValidator("json", inviteMemberSchema)`.
- Calls `inviteTenantMember({ tenantId, tenantSlug: c.var.tenant.tenantSlug, email, name })`
  (needs `tenantSlug` added to `TenantVars` read — confirm it's already there;
  `agora/server`'s `TenantVars` — check before implementing, it's used elsewhere for
  branded URLs).
- On success, upsert the `ChronoMemberProfiles` row for that `memberId` as
  `applicationStatus: "approved", approvedAt: now` if it doesn't already exist (mirrors
  the `autoApprove` branch already in `portal-routes.ts:96-109`) — an invited customer
  is approved by construction, no separate approve step.
- `recordStaffAudit(c, { action: "chronoMemberProfile.invited", targetType: "tenantMember", targetId: member.id, targetLabel: member.email })`.
- Response: `c.json({ memberId, email, name, resent }, 201)`.
- 409 from `inviteTenantMember` (already-active customer) propagates as-is via
  `HttpError`.

### 4. Chrono web — accept-invite page

New `apps/chrono-web/src/app/portal/accept-invite/page.tsx`, a near-copy of
`apps/chrono-web/src/app/portal/reset/page.tsx` (90 lines: token from query string,
single password field with `min 8`, `agora/ui` `Card`/`Field`/`Input`/`Button`):

- Calls a new `memberAuth.acceptInvite({ token, password })` client method
  (`packages/agora/src/client/index.ts`, sibling to `reset` at line ~203-204:
  `` acceptInvite: (input) => portal<{ member: Member }>("/accept-invite", input) ``).
- On success: redirect straight to `/portal` (or wherever a signed-in customer lands
  today — check `apps/chrono-web/src/app/portal/` for the existing post-login
  destination) since `/accept-invite` already wrote the session cookie — **not** back to
  `/portal/login` like the reset page does.
- On error (expired/invalid token): show the error, link back to
  `/portal/login`.

### 5. Chrono web — `/dashboard/members` UI

`apps/chrono-web/src/app/dashboard/members/page.tsx`:

- Add an "Invite" `Button` in the toolbar area (next to search/view-toggle, following
  the same slot the staff-invite page uses at
  `apps/chrono-web/src/app/dashboard/settings/members/page.tsx:172`), gated by
  `can(permissions, "memberProfile", "invite")` — mirrors the existing `can(...,
  "staff", "invite")` gate at `settings/members/page.tsx:117`.
- Opens a small Dialog (per `.ai/rules/ui.md` modal layout: this form has only 2 fields
  — name + email — so a single-column `sm:max-w-md` dialog is correct, not the 2-column
  grid standard which only kicks in for 4+ fields).
- On submit, calls the typed client for `POST /rpc/member-profiles/invite`, shows
  `toast.success("Invite sent")` / `toast.error(...)`, closes the dialog, and refetches
  the member list so the new (approved) row appears immediately.
- No "resend" affordance in this pass (Out of Scope below) — re-running Invite with the
  same email against a still-pending invite already resends per the foundation logic
  (§1), it's just not surfaced as a distinct "Resend" button/icon yet.

### 6. Permissions

`apps/chrono-api/src/auth/permissions.ts`:

- `CHRONO_PERMISSION_STATEMENTS.memberProfile`: `["read", "update", "approve", "reject", "invite"]`.
- `CHRONO_ADMIN_GRANTS.memberProfile`: same, full set including `"invite"`.
- `CHRONO_STAFF_GRANTS.memberProfile`: **stays `["read"]`** — inviting a customer is an
  onboarding decision at the same tier as approve/reject (admin+ only today), not
  routine front-desk work. (Flag this as a judgment call to confirm during audit — easy
  to widen to staff later if the developer disagrees.)

## Files to Update

- `packages/agora/src/db/schema/tenant.ts` — comment-only update on
  `tenantMemberToken.purpose` (no migration).
- `packages/agora/src/member-auth/index.ts` — `inviteTenantMember()`,
  `sendMemberInviteEmail()`, `portalAcceptInviteUrl()`, `POST /accept-invite` route.
- `packages/agora/src/contracts/*` — `memberAcceptInviteSchema`.
- `packages/agora/src/client/index.ts` — `memberAuth.acceptInvite(...)`.
- `apps/chrono-api/src/modules/member/contracts.ts` — `inviteMemberSchema`.
- `apps/chrono-api/src/modules/member/routes.ts` — `POST /invite` on
  `memberProfileRoutes()`.
- `apps/chrono-api/src/auth/permissions.ts` — `memberProfile: [...,"invite"]` in
  statements + admin grants.
- `apps/chrono-web/src/app/portal/accept-invite/page.tsx` — new page.
- `apps/chrono-web/src/app/dashboard/members/page.tsx` — Invite button + dialog.
- `apps/chrono-api/src/e2e/permissions.test.ts` — gate test for `memberProfile:invite`.
- New e2e spec: `apps/chrono-web/e2e/tests/members/invite-customer.spec.ts`.

## Step-by-Step Tasks (phased)

**Phase 1 — Foundation mechanism** (`packages/agora`): schema comment, contracts,
`inviteTenantMember`/`sendMemberInviteEmail`/`portalAcceptInviteUrl`, `/accept-invite`
route, `client/index.ts` method. Verify: `pnpm typecheck`.

**Phase 2 — Chrono API**: permission statement + grants, `inviteMemberSchema`,
`POST /invite` route wired to `inviteTenantMember` + `ChronoMemberProfiles` upsert +
audit. Verify: `pnpm typecheck`, `pnpm --filter @agora/api rls:proof`,
`pnpm --filter @agora/api test:permissions`.

**Phase 3 — Chrono web**: accept-invite page, dashboard/members Invite button + dialog.
Verify: manual click-through in the browser (invite a test email, capture the emailed
link from logs/console email sender, accept it, confirm sign-in + approved status).

**Phase 4 — E2E**: `apps/chrono-web/e2e/tests/members/invite-customer.spec.ts` covering
happy path (staff invites → row appears approved → customer receives link → accepts →
signs in on `/portal`), the role gate (a `staff`-only actor cannot invite, per §6), and
cross-tenant isolation (an invite token minted for tenant A cannot be accepted against
tenant B's host).

Commit each phase separately per `.ai/rules/implementation.md`.

## Acceptance Criteria

- Staff with `memberProfile:invite` can invite a customer by name+email from
  `/dashboard/members`; a `staff` role (lacking the grant) cannot see/use the control.
- The invited email receives a link; visiting it and setting a password signs the
  customer in and lands them in the portal.
- The `ChronoMemberProfiles` row is `applicationStatus: "approved"` immediately on
  invite — no separate approve step needed.
- Re-inviting the same still-pending email resends a working link (old link stops
  working); inviting an email that's already an active customer 409s with a clear
  message.
- `rls:proof` still passes; the new permission gate has a passing gate-test that fails
  when the grant is removed.

## Verification Commands

`pnpm typecheck` · `pnpm --filter @agora/api rls:proof` ·
`pnpm --filter @agora/api test:permissions` · the new Playwright spec.

## Out of Scope

- A "Resend" / "Revoke invite" UI action distinct from re-running Invite (mirrors staff
  invites' resend/revoke — deferred, not needed for MVP).
- Bulk/CSV invite.
- Making the customer invite email admin-editable via the foundation
  `notificationTemplate` registry (that registry is staff-only by design today, per
  `.ai/plans/chrono/archive/customer-onboarding/README.md` — this plan's invite email is
  a fixed branded template via `renderBrandedEmail`, same as the existing
  approve/reject emails in `modules/member/routes.ts`).
- Rate-limiting the invite endpoint beyond the existing permission gate (it's a
  staff-authenticated `/rpc` action, not a public endpoint — no `clientIp` throttle
  needed, unlike the `/public/*` routes in `.ai/rules` "Unauthenticated routes").
- Widening `memberProfile:invite` to the `staff` role (kept admin+-only per §6 — revisit
  if the developer wants front-desk staff to invite directly).

## Execution Start Point

Start Phase 1 in `packages/agora/src/member-auth/index.ts`: add `portalAcceptInviteUrl`
next to `portalResetUrl` (`index.ts:76-82`), then `inviteTenantMember` +
`sendMemberInviteEmail` near the existing `sendMemberEmail`/token-mint code in the
`forgot` handler (`index.ts:403-458`) as the closest pattern to copy from.
