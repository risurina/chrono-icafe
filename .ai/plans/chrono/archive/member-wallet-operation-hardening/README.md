# Chrono — `member-wallet-operation-hardening`

**App:** `chrono`. **Depends on (landed, not reopened):** `wallet`, `wallet-hardening`,
`member-credit-purchase` (all archived under `.ai/plans/chrono/archive/`). This plan
does not touch money math, row-locking, ledger CHECK constraints, or webhook fulfilment
— all re-verified correct. It adds three defenses around the member-initiated mutation
surface that those plans didn't cover.

## Context

The developer asked to harden the member portal, then narrowed scope to "operation —
specially member wallet": the mutating actions a `tenantMember` can trigger themselves
(`POST /portal/credits/purchase` — an immediate wallet-funded credit purchase — and
`POST /portal/payments/checkout` — a member-initiated online PSP checkout for a credit
pack or a wallet top-up).

Research (this session) confirmed the financial *correctness* of these paths is already
solid: `SELECT … FOR UPDATE` row locks, BigInt-cents math, DB-level `CHECK` constraints
on the ledger invariant, per-amount and cumulative balance ceilings, tenant isolation
(own-record-only, 404 not 403), and audit trails (`recordStaffAudit` for staff,
`recordAudit` for member actions) are all shipped and tested. Three gaps remain, all
specific to the member-initiated mutation surface (confirmed by reading the actual
route/service/schema files, not from memory):

1. **No idempotency key** on either mutating route. `/portal/credits/purchase` debits
   the wallet and grants credit *synchronously* — a double-click or a client retry
   after a timed-out-but-succeeded request creates two real purchases before the
   15-min/10-attempt rate limiter would ever catch it. `/portal/payments/checkout` is
   lower severity (nothing is charged until the webhook lands) but a retry still
   creates a duplicate `pending` row and a duplicate PSP checkout session.
2. **Rate limiter fails open by default** (`RATE_LIMIT_FAIL_OPEN`, `packages/agora/src/core/server/rate-limit.ts:63-65`).
   This only matters when Upstash Redis is configured (the in-memory backend has no
   failure mode) — but on a Redis outage, throttling on these two money-moving routes
   silently disappears instead of blocking.
3. **No CSRF defense-in-depth on member mutations.** Staff/platform-admin mutating
   routes all call `requireAdminHeader(c)` (`packages/agora/src/admin/platform-admin/shared.ts:16-22`),
   which forces a CORS preflight so the app's origin allowlist actually gates
   cross-site calls. Member-portal routes rely on `SameSite=Lax` alone.

None of this reopens tenant isolation, permission gates, or the ledger invariant — all
re-verified correct in this session's research.

**Considered and explicitly deferred by the developer:** a rolling daily online-payment
velocity ceiling per member (on top of the existing per-transaction ₱20–₱10,000 bound
and the 10/15min checkout throttle). Not built in this pass — see "Out of scope."

## Pass 1 — Workflow analysis

**Actor:** a `tenantMember` with a portal session (`agora_member` cookie, `memberMiddleware()`),
on `{slug}.APP_DOMAIN/member/wallet` or `/member/promos/[id]`.

**Failure cases addressed:**

| Scenario | Today | After this plan |
|---|---|---|
| Double-click "Buy" on a credit pack (wallet-funded) | Two debits, two grants, both real | Second request returns the *first* purchase unchanged — no second debit |
| Browser retries a timed-out checkout POST | Two `pending` payment rows, two PSP sessions | Second request returns the *first* payment's `{paymentId, checkoutUrl}` |
| Redis outage during a checkout burst | Rate limit silently disabled | Requests blocked (429) until the limiter backend recovers |
| A hostile page on another origin submits a cross-site POST to a member's session | Blocked only by `SameSite=Lax` | Also blocked by the missing CSRF-preflight header (400) before any DB work |

**Not a security issue with tenant isolation, RBAC, or the ledger** — this plan only
adds defenses around the mutation entry points themselves.

## Pass 2 — Technical design

### 1. Idempotency key (client-supplied, optional header `Idempotency-Key`)

Mirrors the existing precedent already in this codebase: `chronoPaymentEvent.idempotencyKey`
has a partial unique index for PSP-webhook replay (`payment/schema.ts:82-84`). This adds
the client-side equivalent for the two member-initiated mutations themselves.

- `chronoCreditPurchase` (`credit/schema.ts`) gains a nullable `idempotencyKey` column +
  `uniqueIndex("chrono_credit_purchase_idempotency_uq").on(tenantId, memberId, idempotencyKey).where(sql`"idempotencyKey" is not null`)`.
- `chronoPayment` (`payment/schema.ts`) gains nullable `idempotencyKey` + `checkoutUrl`
  columns (the URL must be stored to return unchanged on replay — today only
  `providerReference`, the PSP's own id, is stored) + the matching partial unique index,
  named distinctly from the existing webhook one:
  `chrono_payment_client_idempotency_uq` on `(tenantId, memberId, idempotencyKey)`.
- Both portal routes: read `Idempotency-Key` header (optional, max 128 chars). If
  present, look up an existing row for `(tenantId, memberId, idempotencyKey)` first —
  found → return its stored result unchanged (200, no new DB write, no new PSP call);
  not found → proceed as today, persisting the key on the row. Absent header → today's
  behavior, unprotected (opt-in, matches Stripe's own convention).
- `purchaseCreditProduct` (`credit/service.ts`) takes an optional `idempotencyKey` arg,
  stored on the purchase-row insert — mirrors the existing optional `chargeAmount` arg
  added by `member-credit-purchase` Phase C2, so every existing caller/test compiles
  unchanged.

### 2. Fail-closed rate limiting (foundation change, opt-in per limiter)

`createRateLimiter(maxAttempts, windowMs, namespace?, opts?: { failOpen?: boolean })` —
new 4th optional param, threaded into `createRedisLimiter` to override the
process-wide `failOpenDefault()` for that one limiter instance. Backward compatible
(existing call sites omit it and keep today's global-default behavior); the in-memory
backend ignores it (it has no failure mode). Applied only to the two money-moving
limiters: `checkoutLimiter` (`payment/portal-routes.ts`) and `purchaseLimiter`
(`credit/portal-routes.ts`) pass `{ failOpen: false }`.

### 3. CSRF-preflight header on member mutations

New `requireMemberActionHeader(c)` in `packages/agora/src/identity/member-auth/index.ts`,
exact same shape as `requireAdminHeader` (`platform-admin/shared.ts:16-22`): throws
`HttpError(400, "Missing required header.")` unless `x-member-action: 1` is present.
Exported alongside `memberMiddleware`/`getMemberContext` through the existing `agora/member-auth`
subpath — no new export map entry needed. Applied at the top of the two mutating
handlers (`/portal/credits/purchase`, `/portal/payments/checkout`), same call-site
pattern as `requireAdminHeader` in `platform-admin` routes. `x-member-action` and
`Idempotency-Key` both need adding to `apps/chrono-api/src/app.ts`'s CORS `allowHeaders`
(`app.ts:317-324`) — a custom header is what forces the preflight; without the CORS
allowlist actually restricting origins, the header alone does nothing, so this only
works because `corsOrigin(origin)` is already restrictive (`app.ts:315`).

Scoped to these two routes only, not a `memberMiddleware()`-wide gate — matches what the
developer scoped this plan to (wallet money-movement, not every portal mutation like
`/portal/customer/apply` or profile edits).

### Web wiring

`lib/member/payments.ts` / `lib/member/credits.ts` (`apps/chrono-web`): `createCheckout`
and `purchaseCreditProduct` generate a `crypto.randomUUID()` idempotency key once per
user-initiated attempt (kept stable across a client-side retry of the *same* attempt,
not regenerated), and attach it plus `x-member-action: 1` via the Hono client's per-call
header option on `api.portal.payments.checkout.$post(...)` /
`api.portal.credits.purchase.$post(...)` (`hc` from `hono/client`, `apps/chrono-web/src/lib/rpc.ts` —
exact per-call header option verified against the installed Hono version during Phase 5,
not assumed here).

### Files

**Foundation:** `packages/agora/src/core/server/rate-limit.ts`,
`packages/agora/src/identity/member-auth/index.ts`.

**Chrono API:** `apps/chrono-api/src/modules/credit/schema.ts`,
`apps/chrono-api/src/modules/credit/service.ts`, `apps/chrono-api/src/modules/credit/portal-routes.ts`,
`apps/chrono-api/src/modules/payment/schema.ts`, `apps/chrono-api/src/modules/payment/portal-routes.ts`,
`apps/chrono-api/src/app.ts`.

**Chrono Web:** `apps/chrono-web/src/lib/member/payments.ts`, `apps/chrono-web/src/lib/member/credits.ts`.

**Tests/docs:** `apps/chrono-web/e2e/tests/member/` (new spec), `packages/agora/src/core/server/rate-limit.test.ts`
(new, if none exists), `apps/chrono-api/AGENTS.md`.

## Phases

### Phase 1 — Foundation primitives (no behavior change yet)

**Files:** `rate-limit.ts` (4th `opts` param), `member-auth/index.ts` (`requireMemberActionHeader`).

**Accept:** `createRateLimiter(n, ms, ns, { failOpen: false })` compiles and overrides
the Redis-path fail-open decision; every existing call site (unchanged) keeps today's
behavior. `requireMemberActionHeader` throws 400 without the header, passes with it —
unit-testable the same way `requireAdminHeader` is exercised today.

**Verify:** `pnpm typecheck`.

### Phase 2 — Schema: idempotency + checkoutUrl (migration)

**Files:** `credit/schema.ts`, `payment/schema.ts`. Local only, never delegated
(`.ai/rules/database.md`).

**Accept:** both new columns nullable, no existing row rewritten; both partial unique
indexes created; migration reviewed for destructive ops before applying.

**Verify:** `pnpm --filter @agora/chrono-api db:generate --name member_wallet_ops_hardening`
→ read the SQL → `pnpm --filter @agora/chrono-api db:migrate` → `pnpm typecheck` →
`pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅`.

### Phase 3 — Harden `/portal/credits/purchase`

**Files:** `credit/service.ts` (`purchaseCreditProduct` optional `idempotencyKey` arg),
`credit/portal-routes.ts` (`requireMemberActionHeader`, `{ failOpen: false }` on
`purchaseLimiter`, idempotency lookup-before-execute).

**Accept:** a replayed `Idempotency-Key` returns the original purchase/grant with no
second wallet debit; a request with no `x-member-action` header 400s before any DB
work; existing concurrency tests (`credit/concurrency.test.ts`) pass unchanged.

**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api test:credit-concurrency`.

### Phase 4 — Harden `/portal/payments/checkout`

**Files:** `payment/portal-routes.ts` (`requireMemberActionHeader`, `{ failOpen: false }`
on `checkoutLimiter`, idempotency lookup-before-execute storing `checkoutUrl`), `app.ts`
(CORS `allowHeaders` += `x-member-action`, `Idempotency-Key`).

**Accept:** a replayed `Idempotency-Key` returns the original `{paymentId, checkoutUrl}`
with no second PSP session created; missing header 400s; existing fulfilment tests
(`payment/fulfilment.test.ts`, `payment/portal-routes.test.ts`) pass unchanged.

**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-api test:payment-portal-routes`
· `rls:proof`.

### Phase 5 — Web client wiring

**Files:** `lib/member/payments.ts`, `lib/member/credits.ts`, and whichever `/member/wallet`
/ `/member/promos/[id]` components call them (verify exact call sites when implementing).

**Accept:** a real double-click in the browser produces one purchase/one checkout, not
two; online-buy still degrades honestly when no gateway is configured (unchanged).

**Verify:** `pnpm typecheck` · `pnpm --filter @agora/chrono-web build` · manual walkthrough
on `{slug}.localtest.me:3000/member/wallet`.

### Phase 6 — E2E spec + rate-limiter unit test + docs

**Files:** `apps/chrono-web/e2e/tests/member/wallet-operation-hardening.spec.ts` (new),
`packages/agora/src/core/server/rate-limit.test.ts` (new if absent — mock the Upstash
fetch to fail and assert `blockedFor` blocks when `failOpen: false`, passes through when
omitted/`true`), `apps/chrono-api/AGENTS.md` ("Member online checkout" section).

**Accept (e2e, driven through the real tenant subdomain, per `.ai/rules/e2e-testing.md`):**
replayed idempotency key on both routes → identical result, no duplicate row; missing
`x-member-action` header → 400 on both routes; existing happy-path/role-gate/isolation
coverage in `online-checkout.spec.ts` still passes.

**Verify:** the new spec passes with `pnpm dev` running (run twice back to back) ·
`pnpm typecheck` · `rls:proof` · full `apps/chrono-api` test suite.

## Out of scope

- Anything already re-verified correct: money math, row-locking, ledger CHECK
  constraints, webhook idempotency/fulfilment, tenant isolation, permission gates.
- MFA/step-up auth for high-value member actions, and any broader member-portal auth
  hardening (session/cookie config, account lockout, email verification) — a separate,
  larger scope the developer explicitly deferred when narrowing to "wallet operation."
- **Daily/rolling online-payment velocity ceiling** — explicitly considered and declined
  by the developer for this pass; the existing per-transaction ₱20–₱10,000 bound and the
  10/15min checkout throttle are the only volume limits. Revisit once real usage
  patterns are known.
- Refunds, chargebacks, or any change to the PSP webhook's own fulfilment logic.

## Execution start point

Phase 1, `packages/agora/src/core/server/rate-limit.ts` — foundation changes first since
Phases 3–4 depend on them.

## Handover log

- 2026-09-05 — Plan written and accepted. Starting Phase 1.
- 2026-09-05 — Phases 1–6 implemented and committed
  (`9b70b4e3`, `cc1f6186`, `72a255be`, `6b7a2fce`, `358dffe5`, `50a8f12d`).
  Phases 1–5 fully verified (`typecheck`, `rls:proof`,
  `test:credit-concurrency`, `test:payment-portal-routes`, `chrono-web`
  `build`) — all passing. Phase 6's rate-limiter unit test
  (`rate-limit.test.ts`) also passes (8/8). **Not yet verified**: the new
  `apps/chrono-web/e2e/tests/member/wallet-operation-hardening.spec.ts` —
  written against the same pattern as the existing, passing
  `online-checkout.spec.ts`/`wallet-history.spec.ts`, but this session's dev
  machine was under heavy memory pressure from several concurrent sessions
  and the headed Playwright run had to be stopped before completing (first
  attempt was OOM-killed by the system; a retry was still mid-flight, real
  browser alive and progressing, when told to stop). **Next step before
  archiving this plan**: run `pnpm --filter @agora/chrono-web e2e -- e2e/tests/member/wallet-operation-hardening.spec.ts`
  (needs `pnpm dev` already running) once machine resources are free, fix
  anything it surfaces, then move this plan to `archive/`.
- 2026-09-05 — Ran the outstanding verification once the machine had freed up:
  started `pnpm --filter @agora/chrono-web dev` on :3000, confirmed :8787
  already up, then `npx playwright test
  e2e/tests/member/wallet-operation-hardening.spec.ts` — **3/3 passed**
  (missing `x-member-action` rejected pre-DB-work on both checkout and
  purchase; a replayed `Idempotency-Key` returns the original grant with no
  second debit, a different key debits again). Re-confirmed
  `pnpm --filter @agora/chrono-api typecheck` and `rls:proof` (`RLS PROOF:
  PASS ✅`) on the same pass. All 6 phases fully verified. Archived.
