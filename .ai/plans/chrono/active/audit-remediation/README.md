# Chrono — `audit-remediation`

Closes the defects found by a full, plan-by-plan audit of all 22 Chrono plans
(2026-09-02). Each plan was audited by an independent agent that established
implementation state from `git` itself rather than from any status table — a
precaution added after an earlier audit produced two false blockers by trusting a
stale snapshot.

This plan owns **only the cross-module remediation**. A finding that belongs
entirely inside one module's own plan (an unresolved Open Question, an
unexpanded phase) stays with that plan and is listed under "Delegated back" at
the end.

**Verdict spread:** 8 APPROVED WITH CONDITIONS, 14 NEEDS REVISION. No plan was
clean. Two "approved" modules carry blockers — the verdict reflected that the
module is built and structurally sound, not that nothing needed fixing.

---

## Pass 1 — Workflow Analysis

**Who is affected, in severity order:**

- **The venue owner, financially.** Two shipped defects create or destroy money
  without a bug report: a POS refund can be double-submitted to credit a wallet
  twice, and a shift can be closed by someone who did not open it. Neither
  surfaces as an error — the first looks like a generous refund, the second like
  a cash discrepancy attributed to the wrong cashier.
- **Every tenant, in isolation terms.** An unthrottled, unauthenticated device
  pairing endpoint with a low-entropy code and a non-unique cross-tenant lookup
  is the single largest tenant-isolation exposure found. A successful guess
  returns a live bearer token plus `tenantId`/`branchId`.
- **Customers, in availability terms.** A station's first reservation of any
  window can be double-booked, because `SELECT … FOR UPDATE` cannot lock a row
  that does not exist yet. Two customers arrive for the same seat.
- **The next agent or Jules session.** Four systemic documentation defects
  (below) would each cause new, correct-looking work to be built on false
  premises.

**Failure cases addressed:** money created by a concurrent refund; a seat sold
twice; a device paired into the wrong tenant; a brute-forced pairing code; cash
variance attributed to the wrong staff member; an HMAC signing key served in a
list response; an integer overflow surfacing as a 500 mid-transaction.

---

## Pass 2 — Technical Planning

### The three concurrency defects share one root cause

`pos.refundSale`, `reservation.assertNoOverlap`, and (in plan form)
`promo`/`credit` all perform a **read-then-write without holding a lock that
actually serializes contenders**. `wallet/service.ts:22-41` is the correct
reference: it locks a *pre-existing anchor row* whose existence is guaranteed,
then computes from the locked row.

The distinction that matters, and that the reservations plan got wrong:

- **Locking an existing row** (wallet, sale, shift) serializes correctly —
  `SELECT … FOR UPDATE` on a row that exists blocks the second transaction.
- **Preventing a row that does not yet exist** (an overlapping reservation)
  cannot be done with `FOR UPDATE` at all. It needs a **database constraint** —
  a `btree_gist` exclusion constraint — because the second transaction has
  nothing to block on.

So POS and shifts get row locks; reservations gets a constraint. Applying the
wrong remedy to either is why the defect exists.

### The permission violation is live, not stale plan text

Unlike the four plans whose *text* wrongly names `packages/agora`, `members`
actually put Chrono's permissions there: `customer: ["approve","reject"]` at
`packages/agora/src/auth/permissions.ts:49,104`, plus `bad269a` widening the
foundation's own `staff` role with `customer:["read"]` for Chrono's members
list. Commit `139c455` migrated Chrono's permissions to the app seam and missed
these three edits.

`approve`/`reject` are venue-membership workflow, not foundation-generic
customer CRUD — they belong in Chrono. Moving them is a behaviour-preserving
refactor **only if** the grant sets are reproduced exactly; otherwise a member
silently loses access on their next request.

### The `qrSecret` exposure is latent but scheduled

`station/routes.ts:122,163` return `tx.select()` raw rows. `chronoStation`
carries `qrSecret` (an HMAC signing key) and `qrSecretVersion`, currently unpopulated
— so nothing leaks today. The `qr` module's Phase 3 populates that column, at
which point every `station:read` holder, `staff` included, receives the signing
key in a list response and can forge that station's QR codes indefinitely.

This must land **before** qr Phase 3, not after. It is the same
raw-rows-as-transport defect the branches, members, and loyalty audits each
found independently (`.ai/rules/dto.md`), which is why Phase 6 fixes the
pattern rather than only this instance.

### Out of scope

- Building any unbuilt module (sessions, credits, vouchers, promos, qr,
  inquiries, security-alerts, public-stations, tenant-landing, reconciliation,
  onboarding-checklist). Their plan corrections are Phase 9; their
  implementation stays with their own plans.
- The `wallet` e2e spec (owed by the `wallet` plan) and the outstanding
  `test:wallet-concurrency` re-run (owed by `wallet-hardening`).
- Any change to tenant isolation architecture, RLS policy, or the permission
  engine itself.

---

## Phase 1 — POS refund: row lock + atomic stock restore

The highest-severity shipped defect: concurrent refunds credit a wallet twice.

**Files to update**

- `apps/chrono-api/src/modules/pos/service.ts` — in `refundSale`:
  - make the first statement a `select … .for("update")` on the `chronoSale`
    row, and re-check `status` **after** the lock is held (currently `:281-291`
    reads with a plain `select`);
  - replace the read-then-write stock restore (`:313-322`) with an in-place
    `set({ stockQuantity: sql\`"stockQuantity" + ${qty}\` })`, or lock the
    product rows in ascending id order reusing `lockAndValidateProducts`'
    existing ordering discipline. The plan promised a "row-locked increment"
    (pos README:216) and did not get one.
- `apps/chrono-api/src/modules/pos/concurrency.test.ts` — add a double-submit
  refund case: fire N concurrent refunds of one sale, assert exactly one
  succeeds, the wallet is credited exactly once, and stock is restored exactly
  once.

**Acceptance criteria**

- N concurrent `POST /pos/sales/:id/refund` on one sale → exactly one 200, the
  rest 409/422; wallet balance increases by the refund amount **once**.
- Concurrent refund + checkout on the same product do not lose either stock
  update.
- Existing checkout concurrency cases still pass.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:pos-concurrency`

**Execution start point:** `apps/chrono-api/src/modules/pos/service.ts:281`.

---

## Phase 2 — Reservations: exclusion constraint, and reopen the plan

**Files to update**

- `apps/chrono-api/src/modules/reservation/schema.ts` — add the exclusion
  constraint the plan specced as "Phase 1b" and never shipped:
  `EXCLUDE USING gist (tenantId WITH =, stationId WITH =, tsrange(startAt, endAt, '[)') WITH &&) WHERE (status IN ('confirmed','checked_in'))`.
  Include `tenantId` in the constraint key. Requires the `btree_gist` extension.
- New migration via `pnpm --filter @agora/chrono-api db:generate --name
  add_reservation_overlap_exclusion`. Drizzle may not express `EXCLUDE`
  natively — if not, hand-write the SQL in the generated file (allowed; review
  it as `.ai/rules/database.md` requires) including
  `CREATE EXTENSION IF NOT EXISTS btree_gist;`.
- `apps/chrono-api/src/modules/reservation/routes.ts` — map Postgres `23P01`
  (exclusion violation) to the existing 409. Keep `assertNoOverlap` as the
  friendly pre-check; it is no longer the guarantee.
- Move `.ai/plans/chrono/archive/reservations/` back to
  `.ai/plans/chrono/active/reservations/` until its own verification actually
  runs — its HANDOVER's stated next step ("run/verify the Phase 5 spec") was
  never done, and `overlap.test.ts:96-97` skips silently without
  `TEST_DATABASE_URL`.

**Pre-flight:** check for existing overlapping rows before adding the
constraint — `ADD CONSTRAINT` fails on a violating row. Expect zero.

**Acceptance criteria**

- N concurrent identical-window `POST /reservations` on a station with no prior
  booking → exactly one 201, rest 409.
- `overlap.test.ts` runs (not skips) and its concurrency case passes.
- Boundary behaviour unchanged: a booking ending 14:00 does not conflict with
  one starting 14:00 (half-open `[start, end)`).

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- the reservation overlap test with a real `TEST_DATABASE_URL`

**Execution start point:** the pre-flight overlap query.

---

## Phase 3 — Devices: throttle pairing, and make the code unguessable

Two blockers, one endpoint.

**Files to update**

- `apps/chrono-api/src/app.ts` — put a rate limiter in front of
  `POST /api/v1/device/pair` and `POST /api/v1/device/auth`, using the existing
  `createRateLimiter` + `clientIp` from `agora/server`
  (`packages/agora/src/server/rate-limit.ts:172,184`; precedent at
  `app.ts:350-367`). Key per-IP **and** per-pairing-code. Pin concrete limits in
  the code, not "some throttle".
- `apps/chrono-api/src/modules/device/schema.ts` — add a partial unique index on
  `pairingCode` where `status = 'active'`, so two tenants cannot hold the same
  live code. Migration via `db:generate --name add_device_pairing_code_unique`.
  Pre-flight for existing duplicates first.
- `apps/chrono-api/src/modules/device/routes.ts` — generate the code from
  `crypto.randomBytes` over an unambiguous uppercase alphabet (no `O`/`0`/`I`/`1`),
  ≥10 chars, replacing `createId().slice(0,8).toUpperCase()` (`:224`); refuse to
  mint on unique-violation and retry.

**Also decide and record** (audit finding 3): `/pair` currently overwrites the
shared provisioning token's `tokenHash` on every redemption, so with
`maxUses > 1` each PC invalidates the previous one. Either enforce
single-redemption or move minted tokens to child rows. Pick one and write it in
the devices plan.

**Acceptance criteria**

- Exceeding the pairing limit returns 429, not a pairing attempt.
- Two tenants cannot both hold the same active pairing code.
- A generated code is ≥10 chars from the restricted alphabet.
- Existing successful pairing flow still works end to end.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- devices e2e spec

**Execution start point:** `apps/chrono-api/src/app.ts`, beside the existing
auth limiter.

---

## Phase 4 — Shifts: close ownership + row lock

**Files to update**

- `apps/chrono-api/src/modules/shift/routes.ts` — `POST /shifts/:id/close`:
  `select … .for("update")` on the shift row, re-check it is still open under
  the lock, and require `staffUserId === c.var.tenant.userId` **unless** the
  actor holds a new admin-only action.
- `apps/chrono-api/src/auth/permissions.ts` — add `shift: [… , "closeAny"]` to
  `CHRONO_PERMISSION_STATEMENTS` and to `CHRONO_ADMIN_GRANTS` only (not staff).
- `apps/chrono-api/src/e2e/permissions.test.ts` — assert staff is denied
  `closeAny` and admin is allowed. The test must fail if `closeAny` is added to
  the staff grant.

**Acceptance criteria**

- Staff A cannot close staff B's shift (403); admin can.
- Concurrent double-close → one succeeds, one 409.
- Existing open/close flow for one's own shift unchanged.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

**Execution start point:** `apps/chrono-api/src/modules/shift/routes.ts`, the
close handler.

---

## Phase 5 — Move Chrono's customer permissions out of the foundation

Behaviour-preserving refactor. The grants must be reproduced **exactly** or
members lose access.

**Files to update**

- `packages/agora/src/auth/permissions.ts` — remove `approve`/`reject` from the
  `customer` resource (`:49`) and from the admin grant (`:104`); revert
  `bad269a`'s `customer:["read"]` widening of the foundation `staff` role
  (`:90`). Leave foundation-generic `customer` actions intact.
- `apps/chrono-api/src/auth/permissions.ts` — add
  `memberProfile: ["read", "update", "approve", "reject"]` to
  `CHRONO_PERMISSION_STATEMENTS`, with `read` for staff and the rest at admin+,
  matching the grants being removed.
- `apps/chrono-api/src/modules/member/routes.ts` + `portal-routes.ts` — repoint
  gates to the new resource via the app-local typed wrapper.
- `apps/chrono-api/src/e2e/permissions.test.ts:211-216` — update; add a
  Chrono-side gate test.

**Acceptance criteria**

- No Chrono-specific action remains in `packages/agora/src/auth/permissions.ts`.
- The same roles can perform the same member actions as before the move.
- `@agora/api` (scaffold) permission tests still pass — the foundation revert
  must not break the scaffold.

**Verification**

- `pnpm typecheck` (whole workspace — this touches `packages/agora`)
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/api test:permissions`
- `pnpm --filter @agora/api rls:proof` **and**
  `pnpm --filter @agora/chrono-api rls:proof`

**Execution start point:** `packages/agora/src/auth/permissions.ts:49`.

---

## Phase 6 — DTO sweep: stop returning raw Drizzle rows

Closes the latent `qrSecret` exposure and the pattern behind it. **Must land
before `qr` Phase 3.**

**Files to update**

- `apps/chrono-api/src/modules/station/routes.ts` — explicit column lists (or a
  `toStationDto`) on both GETs (`:122`, `:163`) and every `.returning()`;
  `qrSecret`/`qrSecretVersion` must never appear in a response.
- `apps/chrono-api/src/modules/station/contracts.ts` — add the response schema.
- `apps/chrono-api/src/modules/member/routes.ts:159,186,212` and
  `portal-routes.ts:28,63` — add `toMemberProfile()`; dates as ISO strings.
- `apps/chrono-api/src/modules/loyalty/routes.ts:200,231,262` — use the already
  defined but unused `loyaltyAccountSchema`/`loyaltyTransactionSchema`; make the
  zero-state a stable `{ account: dto | null }` rather than a shape-shifting
  object.
- `apps/chrono-api/src/modules/branch/routes.ts:72,82` — explicit columns.

**Acceptance criteria**

- No station response body contains `qrSecret` — assert this in a test, not by
  inspection.
- No route returns a raw `$inferSelect` row; dates cross the wire as ISO
  strings.
- The web app still typechecks against the narrowed shapes.

**Verification**

- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

**Execution start point:** `apps/chrono-api/src/modules/station/routes.ts:122`.

---

## Phase 7 — Money helpers + remove the float fallbacks

**Files to update**

- `apps/chrono-api/src/modules/wallet/money.ts` — add `multiplyMoney(a, n)`,
  `subtractMoney(a, b)`, `compareMoney(a, b)`, all BigInt-cents, same
  string-in/string-out shape as `addMoney`. Their absence is why POS reached for
  `Number()`.
- `apps/chrono-api/src/modules/pos/service.ts:161,174,177` — replace the three
  float sites.
- `apps/chrono-api/src/modules/loyalty/service.ts` + `contracts.ts` — add a
  `MAX_POINTS_BALANCE` guard on `balanceAfter`/`lifetimePointsAfter` and a
  `.min()/.max()` on `adjustPointsSchema.delta`, mirroring
  `wallet/service.ts:63-66`. `int4` overflow currently surfaces as a raw 500.

**Acceptance criteria**

- No `Number()` arithmetic on a money value anywhere in `modules/`.
- A points adjustment that would overflow `int4` returns 409, not 500.
- Existing pos and wallet concurrency suites pass unchanged.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api test:pos-concurrency`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

**Execution start point:** `apps/chrono-api/src/modules/wallet/money.ts`.

---

## Phase 8 — Foundation: make `resolveOrgFromRequest` status-aware

`public-stations` and `tenant-landing` independently both assumed
`resolveOrgFromRequest` (`packages/agora/src/server/host.ts:29`) filters
`organization.status`. It does not — a `suspended`/`cancelled`/`archived`/
`deleting` tenant still resolves. Two plans making the same wrong assumption is
a signal about the helper, not about the plans.

**Decision required before implementing:** either (a) filter terminal statuses
inside the helper — safest, but changes existing `/public/tenant` and
`/public/branding` behaviour, so it needs its own check for callers relying on
resolution-regardless-of-status; or (b) leave the helper and export a
`TERMINAL_TENANT_STATUSES` set plus a documented note, requiring each public
route to check. **Recommendation: (a)**, since (b) reproduces the exact
assumption that caused this.

This phase touches `packages/agora` and therefore belongs in a foundation plan
per `.ai/rules/feature-planning.md`. **Split it out to
`.ai/plans/agora/active/public-host-status-filter/` before implementing** —
recorded here only so the finding is not lost.

---

## Phase 9 — Documentation sweep (four systemic patterns)

No code. One commit per pattern so each is reviewable.

**9a — permission-seam text.** Repoint every plan that tells the implementer to
edit `packages/agora/src/auth/permissions.ts`:
`.ai/plans/chrono/active/{branches,shifts,sessions,credits}/README.md` (and
their HANDOVERs). Each must name `apps/chrono-api/src/auth/permissions.ts` +
`registerAppPermissions()`. `wallet` is already corrected (`a5377c5`) — use it
as the template.

**9b — false HANDOVER status tables.** `stations` (phases 3–5), `members`
(1–5), `shifts` (3–5), `devices` (1, 3, 4) all record committed work as "not
started"; `members` additionally asserts work "remains entirely unbuilt anywhere
in this repo". Correct each against `git log`, with commit SHAs.

**9c — stale dependency premises.** Remove the BLOCKED banner and stale claims
from: `vouchers` ("pos has no service/routes" — shipped in `17963ea`),
`security-alerts` ("devices schema has not landed" — shipped, mounted),
`reports` ("pos tables empty in practice"), `onboarding-checklist` ("stations
routes pending" — mounted at `rpc.ts:1372`), `tenant-landing` (Phase 1 already
landed in `0009_add_chrono_batch2_schemas.sql`).

**9d — wrong verification target.** `reports`, `inquiries`, `tenant-landing`,
`onboarding-checklist` specify `pnpm --filter @agora/api …` — the *scaffold*.
Repoint to `@agora/chrono-api`, and to `pnpm --filter @agora/chrono-web e2e`
(the script is `e2e`, not `test:e2e`).

**9e — plan closure.** Move fully-implemented plans from `active/` to
`archive/`: `branches`, `stations`, `shifts`, `members`, `devices`. Delete
`apps/chrono-api/src/modules/README.md`, whose "folder is currently empty" text
is false now that 18 modules exist.

**Acceptance criteria**

- `grep -rn "packages/agora/src/auth/permissions" .ai/plans/chrono/` returns
  nothing.
- `grep -rn "filter @agora/api" .ai/plans/chrono/` returns nothing.
- No HANDOVER status table contradicts its own log or `git log`.
- No plan carries a BLOCKED banner naming a dependency that has shipped.

---

## Delegated back to each module's own plan

These are real findings this plan does **not** own — they belong to unbuilt
modules and must be fixed in those plans before their code is written:

- **reconciliation** — expected-cash formula is wrong twice (subtracts refund
  cash never added; subtracts an already-negative wallet debit). Highest-value
  plan fix in the set; the module is unbuilt, so it is free to fix now.
- **sessions** — wallet lock taken before the station lock; balance read
  unlocked then re-read under lock, making a legitimate close 422 and roll back
  (session stuck open, unbillable); `Number()` guard; three open questions.
- **credits** — locking `SELECT` lacks `ORDER BY` (deadlock); purchase takes the
  wallet lock first; wallet txn unlinked to the purchase.
- **promos** — `computeDiscount` unspecified/unbounded with no clamp to
  subtotal; concurrency test passes whether or not the guard works.
- **vouchers** — contracts admit a float on the percentage path; voucher/wallet
  lock order unstated; code generation unspecified.
- **qr** — consume does not bind token tenant to session tenant; `qrSecret`
  at-rest decision; rate limiting left open; 60s TTL contradicts the printed-
  sticker use case; e2e missing the role gate.
- **inquiries**, **public-stations**, **tenant-landing** — unauthenticated
  routes with unpinned rate limiting; public routes mis-mounted under `/rpc`
  (which applies `tenantMiddleware()`, so anonymous requests 401);
  `ctaHref` unvalidated into a public `href`.
- **security-alerts** — nothing emits alerts; the real emitters already exist
  unwired in `device/routes.ts`. A feed nothing feeds is false assurance.
- **onboarding-checklist** — misfiled: its first two phases change
  `packages/agora`, so it must split into a foundation plan + a Chrono plan.

## Verification summary

- `pnpm typecheck` (workspace-wide, after Phase 5)
- `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅`
- `pnpm --filter @agora/api rls:proof` (Phase 5 touches the foundation)
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test:pos-concurrency`
- `pnpm --filter @agora/chrono-api test:wallet-concurrency`

## Delegation

**No phase here is Jules-eligible.** Phases 1–4 are concurrency and
authorization fixes in money-moving code; Phase 5 moves permission grants across
the foundation boundary; Phase 6 closes a credential-exposure path; Phase 8 is a
foundation change. All are exactly what `.ai/rules/feature-planning.md` reserves
for local work with local verification.
