# Chrono — `qr` module

**Depends on:** `stations` (schema + RLS implemented, `557b43e`/`12cd72f` — `chronoStation`
exists and is what a QR code ultimately resolves to). **Soft dependency on `sessions`**:
`apps/chrono-api/src/modules/session/` today has only `contracts.ts` + `money.ts` — no
`schema.ts`, no routes, no `chronoSession` table in `db/schema.ts`. The QR "scan to start
a session" flow's *last step* (actually starting a session) cannot be wired until
`sessions` Phase 1 (schema) lands. This plan is written so everything up through
"resolve the scanned code to a station, tenant, and identity" ships now, and the final
"start the session" call is a single, clearly-labeled call-out once `sessions` exists —
see "Dependency decision" in Pass 2.

---

## What this is

QR-code-based station check-in: a station displays a rotating, signed QR code; a
customer scans it with their phone, which resolves to that station and offers to start a
session there — either by an already-logged-in `tenantMember` or by prompting them to
log in first. This turns "walk up and hunt for staff" into a phone-scan-to-play flow, and
is Chrono's most sensitive **public, unauthenticated-adjacent** surface: the scan
redirect and the token-verification endpoint are hit by an unauthenticated phone camera
before any tenant login has happened.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Customer (`tenantMember`)** — scans a station's QR with their phone camera (a plain
  URL, not an app), lands on a resolved-tenant login/confirm page, and (once logged in)
  starts a session on that specific station.
- **Staff / Admin / Owner** — no active role in the scan flow itself; a station's QR
  code is generated/displayed once at setup (or regenerated if compromised), which this
  plan treats as a staff-facing action (**station detail page → "Show/Regenerate QR"**).
- **Platform admin** — not built in this pass.

**Workflow:** A station has a QR code shown on-screen (via a small kiosk display or a
printed sticker — the physical medium is out of scope; this plan only builds the
resolvable URL/token the QR encodes). A customer's phone scans it, opening
`https://{tenant-host}/q/{token}` (or the apex-domain redirect variant if the tenant's
custom domain isn't known to the phone yet — see "Host resolution" below). The server
verifies the token, resolves the station + tenant, and:
- If the customer has no active `tenantMember` session on that host → redirect to
  `/portal/login?next=/portal/stations/{stationId}/start` (reuses the existing
  foundation tenant-member auth pages — **no new customer identity system**, per the
  ratified cross-cutting decision).
- If already logged in → land directly on a confirm-and-start screen showing the
  station name/branch and a **Start Session** button.

Because `sessions` doesn't exist yet, "Start Session" in this pass calls a **stub
resolve-only endpoint** that returns the resolved station/tenant/customer context and
renders "Session starting isn't available yet" — see Dependency decision. Once
`sessions` lands, that same button's handler is repointed at the real start-session
route in one follow-up phase.

**Failure cases:**

- Malformed/tampered token → 400, generic "Invalid or expired code" (never reveals
  *which* part failed — signature vs. format vs. expiry — to avoid leaking a probing
  attacker feedback, see Divergence 1).
- Expired token → same generic message; the token is short-lived and rotates (see
  Schema/Divergences — this plan does **not** use oikos's 5-minute static-secret HMAC
  scheme, see Divergence 2), so an expired scan just means "the screen refreshed, scan
  again."
- Token replay (same token scanned twice, e.g. two phones photographing the same
  screen) → the **second** use is rejected with a distinct, honest message ("This code
  has already been used — ask staff for a fresh one") via an atomic
  insert-or-conflict on a used-token ledger, not a vague "invalid code" (see Schema).
- A station that's been deleted/deactivated since the QR was generated → 404, resolved
  inside `withTenant` before use.
- Wrong tenant / cross-tenant token forgery attempt → the signature check itself is the
  defense (HMAC keyed off a server secret + a per-station rotating value, never
  guessable from another tenant's own valid token) — **tenant-isolation leak scenario**:
  even if an attacker enumerates plausible station ids across tenants, they cannot mint
  a validly-signed token for a station they don't own, and a forged/mismatched
  signature always 400s before any tenant data is touched.
- Rate limiting: repeated invalid-token attempts from one IP are throttled (**Divergence
  3** — oikos's `/validate` endpoint has a rate limiter (`qrLimiter`) but nothing scopes
  it per-token/per-station; this plan keeps a coarse per-IP limiter and adds a
  per-station attempt counter to catch a targeted brute-force against one screen).
- Staff regenerating a station's QR while a customer's phone still has the old one open
  → the old token's signature becomes invalid the moment the underlying signing
  material rotates (see Schema's `qrSecretVersion`), giving an immediate, real
  "regenerate to kill a leaked/photographed code" security control — not present at all
  in oikos (Divergence 4).

**Audit / notifications:** QR regeneration writes `recordStaffAudit`
(`chronoStationQr.regenerated`). A successful resolve-and-start is **not** separately
audited by this module (it's not a staff action) — once `sessions` lands, session start
gets its own audit entry there, matching how `reservations`/`shifts` audit their own
domain actions, not a shared "someone scanned a QR" log.

---

## Pass 2 — Technical Planning

### Dependency decision — ship token/resolve now, stub the session-start call

Same shape of decision as `security-alerts`, applied to a genuinely different
dependency (`sessions` rather than `devices`): the QR **resolution** mechanism (mint a
signed token for a station, verify it, look up station+tenant, gate on customer login)
is fully buildable and independently valuable today — it's the exact mechanism
`reservations`' check-in flow would also want later, and lets staff/QA exercise the
scan→login→confirm UX well before `sessions` exists. Only the literal "create a running
session row" call is blocked. This plan therefore ships Phases 1–4 (schema, contracts,
resolve/verify routes, web scan-landing UI) now, with the confirm screen's **Start
Session** button calling a route that returns `{ resolved: true, sessionStartAvailable: false }`
until `sessions` lands, at which point Phase 5 repoints it — a materially smaller,
more mechanical follow-up than security-alerts' device-endpoint phase, because no new
auth surface is needed here, just a different downstream call.

### Divergences from oikos prior art

Read directly from `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/modules/qr/{routes.ts,member-login-token.ts,host-resolution.ts}`.
oikos's QR design has real, specific weaknesses this plan corrects:

1. **Generic "Invalid or expired QR code" is actually good practice and is kept** — but
   oikos's `/validate` route logs the *raw error* server-side via `logger.warn({ err })`
   while returning the generic message to the client, which this plan also keeps (no
   change needed here — noting it because it's one thing oikos got right, not
   everything is a divergence).
2. **Static-secret HMAC token with no rotation and a bare 5-minute TTL, generated by
   the PC-client device itself, not the server.** oikos's `qr-{deviceId}-{timestamp}-{nonce}:{signature}`
   is signed with a single, permanent `config.deviceTokenSecret` shared across the
   *entire deployment* (not even per-tenant) — if that one secret ever leaks, every
   station's QR across every tenant is forgeable forever, with no rotation mechanism
   anywhere in the code. This plan instead signs with an **HMAC key derived from a
   per-station `qrSecret` + `qrSecretVersion`** stored in `ChronoStations` (a new
   nullable-by-default pair of columns added to the *existing* `stations` module in a
   small additive migration, not a new table) — a single compromised station's QR
   compromises only that station, and staff can invalidate a leaked code by
   regenerating (bumping `qrSecretVersion`) without touching any other station or
   redeploying a global secret. See Schema.
3. **No replay protection on `/validate` itself** — only the *session-start* endpoint
   (`/member/sessions/start-via-qr`) inserts into a `QrTokenUse` nonce ledger; the
   read-only `/validate` (used for the reverse "am I about to scan the right station"
   confirm step) can be replayed indefinitely within its 5-minute window with zero
   consequence, which is fine for a pure read but oikos conflates "validate" and
   "the thing that actually matters is single-use" in a way that's easy to get wrong
   when extending. This plan makes the **single-use ledger the same table for every
   token-consuming action**, not bolted on only to the money-moving one.
4. **No token-rotation-on-compromise story at all.** Nothing in oikos lets an owner say
   "this station's QR sticker got photographed and posted online, kill it" short of
   redeploying the entire service with a new `deviceTokenSecret` (which would break
   every station's QR simultaneously). This plan's per-station `qrSecretVersion` bump
   (Divergence 2) is the fix — a real, scoped "regenerate" button.
5. **Host/domain resolution logic (`host-resolution.ts`) is solid and is adapted, not
   rejected** — the custom-domain-first / tenant-subdomain-fallback / single-webBaseUrl-for-
   local-dev priority order is the right shape and this plan reuses that exact priority
   list, but implemented via agora's own `parseHost`/tenant-domain lookup
   (`.ai/rules/tenant.md`) rather than a bespoke `TenantDomain` query, since agora
   already has this exact concept (`domain` table, custom-domain resolution) built into
   the foundation.
6. **`member/login-token.ts`'s reverse-flow ("phone shows a QR, kiosk camera reads it")
   is a materially different, second QR direction** (phone→kiosk instead of
   kiosk→phone) that depends on the kiosk itself having a camera and a live polling/push
   channel to the API — a `devices`/hardware-capability question, and out of scope for
   this plan (**Open Question 1**: is the phone-shows-QR reverse flow wanted for
   Chrono, and if so is it a `devices`-dependent follow-up, not part of this plan).
7. **No length/format cap enforced before parsing** — oikos's `verifyQrToken` does
   string-splitting on attacker-controlled input before any signature check, which is
   low-risk (JS string ops, no injection vector) but wasteful; this plan Zod-validates
   token shape (`z.string().regex(...)`) before any parsing, failing fast and uniformly.

### Schema — new nullable columns on `ChronoStations`, new `ChronoQrTokenUses` table

**On `chronoStation`** (`apps/chrono-api/src/modules/station/schema.ts`), an additive
migration:

```ts
qrSecret: text("qrSecret"), // random, server-generated on first "Generate QR" action
qrSecretVersion: integer("qrSecretVersion").notNull().default(0),
```

Both null/0 until a station's QR is generated for the first time — no backfill needed,
matches the "left null until a later module populates it" precedent
(`ChronoShifts.expectedCashAmount`).

**New table**, `apps/chrono-api/src/modules/qr/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoStation } from "../station/schema";

export const chronoQrTokenUse = pgTable(
  "ChronoQrTokenUses",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    stationId: text("stationId")
      .notNull()
      .references(() => chronoStation.id, { onDelete: "cascade" }),
    // SHA-256 of the token's nonce — never the raw token (defense in depth:
    // even a DB read of this table can't replay a token from it).
    nonceHash: text("nonceHash").notNull(),
    // Nullable — set once the token is consumed by an authenticated action
    // (session start, once `sessions` exists); null while only "validated"
    // (read-only resolve) has happened. See Divergence 3.
    consumedByMemberId: text("consumedByMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    consumedAt: timestamp("consumedAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_qr_token_use_tenant_idx").on(t.tenantId),
    index("chrono_qr_token_use_station_idx").on(t.stationId),
    uniqueIndex("chrono_qr_token_use_nonce_idx").on(t.nonceHash),
    index("chrono_qr_token_use_expires_idx").on(t.expiresAt),
  ],
);

export type NewChronoQrTokenUse = typeof chronoQrTokenUse.$inferInsert;
export type ChronoQrTokenUseRow = typeof chronoQrTokenUse.$inferSelect;
```

The unique index on `nonceHash` is the DB-level single-use backstop (an atomic insert
that 23505s on replay), matching oikos's own `QrTokenUse` idea but applied uniformly
(Divergence 3), not only on the money-moving path. A scheduled cleanup of expired rows
is **Open Question 2** (cron sweep vs. leave them — they're cheap and useful as an
audit trail of scan attempts, so this plan defaults to **keep, never delete**, unless
volume becomes a real concern).

### Token design

`qr-{stationId}-{version}-{timestamp}-{nonce}:{signature}`, where `signature =
HMAC-SHA256(stationQrSecret, "{stationId}:{version}:{timestamp}:{nonce}")`. Server looks
up the station by `stationId` (parsed from the token, then validated to belong to the
requesting tenant/host — **never trusted as tenant-scoping input by itself**, only as a
lookup key inside `withTenant`), reads its current `qrSecret`/`qrSecretVersion`, and
verifies. A version mismatch (station was regenerated) fails closed with the same
generic message as an invalid signature — no distinct "this code is stale, but not
fake" message, to avoid confirming to an attacker that the station id/format was
otherwise well-formed (tightens Divergence 1's leak-avoidance further than oikos, whose
`QrTokenExpiredError` distinguishes "expired but authentic" from "invalid," which this
plan intentionally does NOT replicate for the same-tenant case — see Open Question 3:
oikos's expired-but-authentic special case exists purely to redirect the user to the
*correct tenant's* login page even on an expired scan; this plan needs that same host-
resolution behavior, so it keeps a narrow version of it — distinguishing "expired" only
enough to still resolve which tenant to redirect to, never surfacing *why* to the
end user beyond "scan again").

### Contracts — `apps/chrono-api/src/modules/qr/contracts.ts`

```ts
import { z } from "zod";

const QR_TOKEN_TTL_SECONDS = 60; // short — rotates fast, unlike oikos's 300s
const QR_TOKEN_RE = /^qr-[A-Za-z0-9]+-\d+-\d+-[a-f0-9]+:[a-f0-9]{64}$/;

export const qrTokenSchema = z.string().regex(QR_TOKEN_RE, "Invalid QR code format");

export const resolveQrSchema = z.object({
  token: qrTokenSchema,
});

export const regenerateStationQrSchema = z.object({
  stationId: z.string().min(1),
});
```

### Routes

**Staff-facing** (`/rpc/stations/:id/qr`, inside `tenantMiddleware()`):
- `POST /rpc/stations/:id/qr/regenerate` — generates a fresh `qrSecret` (if none) or
  bumps `qrSecretVersion` + rotates `qrSecret`, returns the current mintable token +
  its rendering URL. Gate: reuse the existing `station:["update"]` permission — no new
  resource needed, this is a station-configuration action, not a distinct domain
  (**Open Question 4**: confirm `station:update` is the right gate vs. a new
  `qr:manage` resource — this plan defaults to reuse since it's literally a station
  field).

**Public** (mounted outside `/rpc`, outside `tenantMiddleware()`, in `apps/chrono-api/src/app.ts`,
matching `devices`' precedent for a non-session-authenticated surface):
- `GET /public/qr/resolve?token=...` — verifies the token, returns
  `{ tenantSlug, tenantHost, stationId, stationName, branchName, requiresLogin: boolean }`.
  Rate-limited per-IP and per-station (Divergence 3).
- `POST /public/qr/consume` — **requires an authenticated `tenantMember` session** (the
  foundation's customer-pool session, not staff `tenantMiddleware()`), inserts the
  nonce-use row, and (once `sessions` exists) starts the session; today returns the stub
  shape described in the Dependency decision.

This is Chrono's **first genuinely public, pre-tenant-context route** — flagged
explicitly because every other Chrono module so far mounts under `/rpc` behind
`tenantMiddleware()`. `resolve` must do its own minimal host/token-driven tenant lookup
(reading `tenantId` off the resolved station row, inside `withAdmin`/a scoped read, not
`c.var.tenant`) — mirroring how `devices`' pairing endpoint is designed to work with no
prior tenant context, and it must never accept a client-supplied `tenantId`.

---

## Phase 1 — DB Schema + RLS

**Files to Update**
- Update: `apps/chrono-api/src/modules/station/schema.ts` (add `qrSecret`/`qrSecretVersion`)
- New: `apps/chrono-api/src/modules/qr/schema.ts`
- Update: `apps/chrono-api/src/db/schema.ts` (import/re-export `chronoQrTokenUse`,
  add `"ChronoQrTokenUses"` to `APP_TENANT_TABLES`)

**Step-by-Step Tasks**
1. Add the two nullable columns to `chronoStation`.
2. Write `chronoQrTokenUse` per Schema above.
3. Wire into `db/schema.ts`.
4. `pnpm db:generate --name add_chrono_qr_tokens`, review SQL (additive columns +
   new table, no destructive ops).
5. `pnpm db:migrate`.

**Acceptance Criteria**
- `ChronoStations` has the two new nullable columns; `ChronoQrTokenUses` exists,
  RLS-forced, unique on `nonceHash`.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Any session-start wiring (Phase 5, blocked on `sessions`).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/station/schema.ts` and `db/schema.ts` current state
  first (concurrent modules may have landed changes).

---

## Phase 2 — Contracts + Token Signing Helper

**Files to Update**
- New: `apps/chrono-api/src/modules/qr/contracts.ts`
- New: `apps/chrono-api/src/modules/qr/token.ts` (sign/verify helpers, HMAC via
  `node:crypto`, `timingSafeEqual` — never `===` on a signature, matching the one thing
  oikos does correctly here)

**Step-by-Step Tasks**
1. Write contracts per above.
2. Write `mintStationQrToken(station)` / `verifyStationQrToken(token)` pure functions,
   unit-tested directly (no DB) for: valid round-trip, tampered signature rejected,
   expired rejected, version-mismatch rejected, malformed-format rejected before
   parsing.

**Acceptance Criteria**
- Unit tests for all five cases above pass.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:qr` (or the module's own test script)

**Out-of-Scope**
- Routes (Phase 3).

**Execution Start Point**
- Model the file after `apps/chrono-api/src/modules/reservation/overlap.test.ts`'s
  standalone-unit-test style.

---

## Phase 3 — Routes (staff regenerate + public resolve/consume)

**Files to Update**
- New: `apps/chrono-api/src/modules/qr/routes.ts` (staff-facing, mounted under
  `/rpc/stations`)
- New: `apps/chrono-api/src/modules/qr/public-routes.ts` (public, mounted directly in
  `apps/chrono-api/src/app.ts`)
- Update: `apps/chrono-api/src/routes/rpc.ts`, `apps/chrono-api/src/app.ts`

**Step-by-Step Tasks**
1. Implement `POST /rpc/stations/:id/qr/regenerate` — gate `station:["update"]`,
   `recordStaffAudit("chronoStationQr.regenerated")`.
2. Implement `GET /public/qr/resolve` — token verify → station/tenant lookup via a
   scoped admin read (never `c.var.tenant`) → rate-limited (per-IP + per-station) →
   generic error on any failure.
3. Implement `POST /public/qr/consume` — requires an authenticated `tenantMember`
   session (reuse the foundation's tenant-member session check, not staff auth),
   atomic nonce-insert (23505 → "already used"), returns the stub
   `{ resolved: true, sessionStartAvailable: false }` shape until Phase 5.
4. Add both public routes to a rate limiter (reuse or add a minimal one — check if
   agora has an existing rate-limit primitive before building a new one; if none
   exists, a simple in-memory/DB-backed per-IP counter scoped to this route only,
   not a general-purpose limiter — out of scope to build a reusable one here).

**Acceptance Criteria**
- Full round trip: regenerate → mint token → resolve → consume (stub) works.
- Tampered/expired/replayed/version-mismatched tokens all fail with the generic
  message; replay specifically 409s distinctly per Divergence 3's design (resolve
  is read-only/replayable within TTL; consume is single-use).
- Cross-tenant: a token minted for tenant A's station never resolves under tenant B's
  host context (verify by manually constructing a token for A's station and hitting
  `/public/qr/resolve` — the station lookup is by id, not host, so this is really
  testing that the returned `tenantHost` always matches the token's own station, never
  a client-supplied host).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- A route-level test covering the failure matrix above.

**Out-of-Scope**
- Real session start (Phase 5).
- The phone-shows-QR reverse flow (Open Question 1, deferred entirely).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/device/contracts.ts` first — `devices`' plan
  already worked through "public, pre-tenant-context route" design questions this
  phase will hit again (even though `devices`' own routes aren't built yet, its
  contracts + Pass 2 write-up are a directly relevant precedent to reread).

---

## Phase 4 — Web UI + E2E

**Files to Update**
- Update: station detail page/dialog in `apps/chrono-web/src/app/dashboard/stations/`
  (add "Show/Regenerate QR" action, rendering the token as a QR image — client-side QR
  rendering library choice is an implementation detail, not a new dependency category
  per `.ai/rules/providers.md`)
- New: `apps/chrono-web/src/app/q/[token]/page.tsx` — the public scan-landing page
  (resolves via `GET /public/qr/resolve`, then either redirects to
  `/portal/login?next=...` or shows the confirm-and-start screen)
- New: `apps/chrono-web/e2e/tests/qr/qr.spec.ts`

**Step-by-Step Tasks**
1. Add the regenerate action to the station detail UI (component-first, `agora/ui`
   primitives only, per `.ai/rules/component-first-ui.md`).
2. Build `/q/[token]` as a public (no `tenantMiddleware`-equivalent Next.js gate) page —
   confirm this doesn't collide with `.ai/rules/architecture.md`'s "no Next.js
   middleware" rule (it doesn't; this is a normal server component doing a fetch, not
   request interception).
3. Wire the confirm screen's Start button to `/public/qr/consume`, rendering the stub
   "not available yet" message from Phase 3's response shape.
4. E2E: happy path (staff regenerates → scan URL resolves → login redirect for a
   logged-out customer → confirm screen for a logged-in one), tampered-token failure
   path, cross-tenant isolation (a token from tenant A's station never resolves to
   tenant B's branding/host even if requested from tenant B's host).

**Acceptance Criteria**
- A staff session can regenerate a station's QR from its detail view and the new
  token image renders immediately.
- Scanning (visiting) `/q/[token]` for a valid token resolves and either redirects a
  logged-out visitor to `/portal/login?next=...` or shows the confirm-and-start
  screen for a logged-in one.
- A tampered/invalid token renders a clear failure state, not a 500 or a silent
  redirect.
- A token minted for tenant A's station never resolves against tenant B's
  branding/host, even when the request is made from tenant B's host.
- No raw HTML chrome introduced in `apps/chrono-web`.
- All three e2e cases (happy path, tampered-token failure, tenant isolation) pass.

**Verification Commands**
- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`
- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/qr/qr.spec.ts`
  (with `pnpm dev` already running, per `.ai/rules/rbac.md`'s manual Playwright
  convention — no `.env` present in `apps/chrono-api` while running)

**Out-of-Scope**
- Real session start UX (Phase 5).

**Execution Start Point**
- Read `apps/agora-web/src/lib/post-auth.ts`'s `resolveLandingUrl()` pattern before
  building the login-redirect `next=` handling — reuse its same-origin-safety
  discipline, don't hand-roll a new redirect validator.

---

## Phase 5 — Wire Real Session Start (BLOCKED until `sessions` Phase 1 lands)

**Files to Update**
- Update: `apps/chrono-api/src/modules/qr/public-routes.ts` (`POST /public/qr/consume`
  now calls the real session-start service instead of returning the stub)
- Update: `apps/chrono-web/src/app/q/[token]/page.tsx` (confirm screen shows real
  session state instead of the "not available yet" message)

**Step-by-Step Tasks**
1. Confirm `sessions` Phase 1 (schema) is merged and its start-session contract/service
   shape is known.
2. Replace the stub branch in `consume` with a real call, inside the same transaction
   as the nonce-consume insert (start-session and mark-nonce-consumed must be atomic —
   a failed session start must not burn the nonce).
3. Update e2e spec to assert a real session row exists post-scan.

**Acceptance Criteria**
- Scanning a valid QR as a logged-in customer with sufficient balance/credit actually
  starts a session on that station.

**Verification Commands**
- `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof`, updated e2e spec.

**Out-of-Scope**
- Billing-method selection nuances — deferred to `sessions`' own plan, this phase only
  wires the call.

**Execution Start Point**
- **Do not start until `sessions` Phase 1 is verified merged.** Check
  `.ai/handover/chrono-migration.md`'s Plan status table first.

---

## CRUD & Feedback Contract

| Action | Who | Feedback |
|---|---|---|
| Create/regenerate a station's QR secret | staff/admin/owner (`station:update`) | toast success, new QR image rendered immediately |
| Resolve a scanned token | public (unauthenticated) | redirect to login, or a confirm screen; generic error toast on failure |
| Consume a token (start session) | authenticated `tenantMember` | success → session-starting UI (once Phase 5); today, an explicit "not available yet" notice, never a silent no-op |
| Delete | **not supported** — a station's QR is regenerated (invalidating the old one), never "deleted" as a distinct entity; `ChronoQrTokenUses` rows are an append-only usage ledger |

No soft-delete needed. Regeneration is the only "destructive" action and is
audit-linked (`recordStaffAudit`).

---

## Open Questions

1. Is the phone-shows-QR reverse flow (kiosk camera reads a code from the customer's
   phone) wanted for Chrono, and if so, is it its own `devices`-dependent follow-up
   plan rather than part of this one? Defaults to **out of scope** here.
2. Scheduled cleanup of expired `ChronoQrTokenUses` rows, or keep indefinitely as a scan
   audit trail? Defaults to **keep**.
3. Should the resolve endpoint distinguish "expired but authentic" from "genuinely
   invalid" the way oikos does, purely to redirect to the correct tenant host on an
   expired-but-real scan? Defaults to **yes, narrowly** — see Token design.
4. Should QR management get its own `qr:manage` permission resource, or reuse
   `station:update`? Defaults to **reuse `station:update`**.
