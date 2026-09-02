# Chrono — `security-hardening`

Owns the **security-class** findings from the 22-plan audit (2026-09-02): the
unauthenticated attack surface, credential/secret exposure, and the public
tenant-resolution boundary. Split out of
`.ai/plans/chrono/active/audit-remediation/`, which keeps the correctness and
documentation findings.

**The split is deliberate.** These phases share one reviewer mindset (what does
an unauthenticated or under-privileged actor get?), one verification style
(negative tests — assert the thing is *refused*), and a different urgency from
the correctness work. Keeping them in one plan with the money-concurrency fixes
would have buried them. **`audit-remediation` no longer contains Phases 3, 6 or
8 — they moved here** as Phases 1, 3 and 4. Nothing is owned twice.

**Precedent:** `wallet-hardening` did the same thing for the wallet module —
close a specific audit's findings in their own plan rather than reopening a
completed one.

---

## Pass 1 — Workflow Analysis

**The actors this plan defends against**, in order of what they currently get:

- **An anonymous attacker on the internet.** `POST /api/v1/device/pair` is
  unauthenticated, unthrottled, and takes an 8-character uppercase code sliced
  from a nanoid. A hit returns a live provisioning token plus `tenantId` and
  `branchId` — a foothold inside a tenant, from nothing. There is no rate
  limiter anywhere in `apps/chrono-api` (`grep -n "rateLimit" app.ts` returns
  only a comment).
- **A tenant whose code collides with another tenant's.** `pairingCode` carries
  a deliberately non-unique index and is looked up **cross-tenant** via
  `withAdmin` with `.limit(1)`. Two tenants holding the same active code means
  one venue's PC pairs into the other venue's tenant. This is the isolation
  boundary failing, not a hardening nicety.
- **Any `staff` member, once `qr` ships.** `station/routes.ts:122,163` return
  `tx.select()` raw rows, and `chronoStation` carries `qrSecret` — an HMAC
  signing key. Unpopulated today; `qr` Phase 3 populates it, at which point
  every `station:read` holder can forge that station's QR codes indefinitely.
- **Anyone who can reach a suspended tenant's hostname.** `resolveOrgFromRequest`
  does not filter `organization.status`, so a `suspended`/`cancelled`/
  `archived`/`deleting` tenant keeps serving public pages.
- **A tenant staff author.** `ctaHref` on the landing page is unvalidated
  tenant-authored input rendered into an `href` served to anonymous visitors —
  `javascript:` URIs and open redirects under the tenant's own domain.

**What a defender sees when these fail:** nothing. Every one of these is silent
— no error, no audit row, no alert. That is why each phase below ships a
negative test rather than a happy-path assertion.

---

## Pass 2 — Technical Planning

### The rate-limiting gap is a convention gap, not five bugs

Four separate plans (`devices` shipped, `qr`/`inquiries`/`public-stations`
planned) each reached the same point — "this endpoint is unauthenticated, it
should probably be throttled" — and each deferred it to an Open Question or a
hedge ("check if agora has a rate-limit primitive; if not, build one"). It does
have one: `createRateLimiter` + `clientIp`, exported from `agora/server`
(`packages/agora/src/server/rate-limit.ts:172,184`), already used for auth at
`apps/chrono-api/src/app.ts:350-367`.

So the fix is not only "throttle the device endpoint" — it is to make the
convention discoverable so the next unauthenticated route does not re-derive it.
Phase 2 writes it down once, in the app's own rules doc, and the remaining
plans reference it instead of re-deciding.

### Public routes are mounted in a place that cannot work

Both `public-stations` and `tenant-landing` specify mounting under `/rpc`. That
cannot work: `apps/chrono-api/src/routes/rpc.ts:291` applies
`.use("*", tenantMiddleware())` to the whole `rpc` app, so an anonymous request
401s before the handler runs — and `app.ts` applies the maintenance/read-only
gates to `/rpc/*`, so a public marketing page would 503 during maintenance.

The working pattern already exists: `/public/tenant` (`app.ts:459`),
`/public/branding` (`:466`), `/public/sso` (`:498`), mounted on the app outside
`/rpc`. Phase 4 fixes the *helper* those routes depend on; the individual plans
are corrected to mount correctly in their own phases (tracked in
`audit-remediation` Phase 9c).

### Why `resolveOrgFromRequest` changes, not the two call sites

Two independent plans, written at different times by different passes, both
asserted the helper filters terminal statuses. It does not. When two
independent readers arrive at the same wrong belief about a function, the
function's contract is the defect. Patching both call sites leaves the third
caller — whoever writes the next public route — to make the same mistake.

**This phase touches `packages/agora` and therefore belongs in a foundation
plan** (`.ai/rules/feature-planning.md`, "Plan & Analysis Location": a feature
spanning both is split, never filed under one app). Phase 4 below is a
*specification* of that change; implementing it requires creating
`.ai/plans/agora/active/public-host-status-filter/` first. This is called out
rather than quietly done, because doing it from a Chrono plan is precisely the
boundary violation the `members` finding punished.

### Out of scope

- The money-concurrency fixes, the permission-seam move, and the documentation
  sweep — all owned by `audit-remediation`.
- Implementing any unbuilt module. Where a finding belongs to an unbuilt
  module's own plan (qr's tenant binding on consume, inquiries' public
  submission flow), this plan fixes only what is already shipped and records the
  rest as a constraint those plans must satisfy.
- Penetration testing or a formal threat model. These are the specific findings
  from one audit pass, not a complete security review.

---

## Phase 1 — Devices: throttle pairing, and make the code unguessable

Two blockers on one unauthenticated endpoint. Highest-severity item in this
plan.

**Files to update**

- `apps/chrono-api/src/app.ts` — rate-limit `POST /api/v1/device/pair` and
  `POST /api/v1/device/auth` using `createRateLimiter` + `clientIp` from
  `agora/server`, mirroring the auth limiter at `:350-367`. Key **per-IP and
  per-pairing-code** — per-IP alone does not stop a distributed guess against
  one code, and per-code alone does not stop enumeration across codes. Pin
  concrete numbers in code.
- `apps/chrono-api/src/modules/device/schema.ts` — partial unique index on
  `pairingCode` where `status = 'active'`. Migration via
  `db:generate --name add_device_pairing_code_unique`.
- `apps/chrono-api/src/modules/device/routes.ts:224` — replace
  `createId().slice(0,8).toUpperCase()` with `crypto.randomBytes` over an
  unambiguous uppercase alphabet (no `O`/`0`/`I`/`1`), ≥10 characters; on
  unique-violation, retry rather than returning a duplicate.

**Pre-flight:** query for existing duplicate active pairing codes before adding
the unique index — `ADD CONSTRAINT`/`CREATE UNIQUE INDEX` fails on a violation.

**Also decide and record** (audit finding): `/pair` currently overwrites the
shared provisioning token's `tokenHash` on every redemption, so with
`maxUses > 1` (the stated golden-image use case) each PC invalidates the
previous one. Either enforce single-redemption or move minted tokens to child
rows. Write the decision into the `devices` plan.

**Acceptance criteria**

- Exceeding the pairing limit returns 429 — asserted by a test that fires past
  the limit, not by reading the code.
- Two tenants cannot hold the same active pairing code (unique index rejects).
- A generated code is ≥10 characters and contains no ambiguous glyphs.
- The existing successful pairing flow still completes end to end.

**Verification**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- the devices e2e spec

**Execution start point:** the pre-flight duplicate-code query.

---

## Phase 2 — Write down the unauthenticated-route convention

Stops the next four plans from re-deriving it and deferring it again.

**Files to update**

- `apps/chrono-api/AGENTS.md` — a short "Unauthenticated routes" section
  stating: every route reachable without a session mounts under `/public/*` or
  `/api/v1/device/*` on the app (never under `/rpc`, which applies
  `tenantMiddleware()`); every such route is wrapped in `createRateLimiter` +
  `clientIp` from `agora/server` with limits pinned numerically at the mount;
  every such route resolves its tenant server-side and rejects terminal-status
  tenants; and no such route returns a column that is not in an explicit
  allowlist.

This is documentation, but it is the phase that makes the other four stick — the
audit found four plans independently failing the same way, which is a convention
problem, not four authoring mistakes.

**Acceptance criteria**

- The section names the exact exports (`createRateLimiter`, `clientIp`) and the
  exact mount precedent (`app.ts:459`), so a reader does not have to search.
- `public-stations`, `inquiries`, and `qr` plans can cite it instead of
  re-deciding (their edits are tracked in `audit-remediation` Phase 9c).

**Verification:** read-back; no commands.

**Execution start point:** `apps/chrono-api/AGENTS.md`, after "Surfaces".

---

## Phase 3 — Stop returning raw rows; close the `qrSecret` path

**Must land before `qr` Phase 3 populates `qrSecret`.**

**Files to update**

- `apps/chrono-api/src/modules/station/routes.ts:122,163` — explicit column
  lists (or a `toStationDto`) on both GETs and on every `.returning()`.
- `apps/chrono-api/src/modules/station/contracts.ts` — the response schema,
  omitting `qrSecret`/`qrSecretVersion`.
- `apps/chrono-api/src/modules/member/routes.ts:159,186,212` +
  `portal-routes.ts:28,63` — `toMemberProfile()`; dates as ISO strings.
- `apps/chrono-api/src/modules/loyalty/routes.ts:200,231,262` — use the already
  defined, currently unused `loyaltyAccountSchema`/`loyaltyTransactionSchema`;
  make the zero-state a stable `{ account: dto | null }` instead of a
  shape-shifting object the UI would have to branch on.
- `apps/chrono-api/src/modules/branch/routes.ts:72,82` — explicit columns.

**Acceptance criteria**

- A test asserts no station response body contains `qrSecret` — asserted, not
  eyeballed. Write it so it would fail today if the column were populated.
- No route returns a raw `$inferSelect` row; dates cross the wire as ISO
  strings (`.ai/rules/dto.md`).
- `apps/chrono-web` still typechecks against the narrowed shapes.

**Verification**

- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api test:permissions`

**Execution start point:** `apps/chrono-api/src/modules/station/routes.ts:122`.

---

## Phase 4 — Foundation: status-aware public tenant resolution

**Specification only — implementing this requires creating
`.ai/plans/agora/active/public-host-status-filter/` first**, because it changes
`packages/agora`. Recorded here so the finding is not lost with the plan that
found it.

**The change:** `resolveOrgFromRequest` (`packages/agora/src/server/host.ts:29`)
resolves an organization by slug or verified custom domain with no
`organization.status` filter.

**Decision required before implementing:**

- **(a) Filter terminal statuses inside the helper.** Safest default and stops
  the next caller repeating the mistake. But it changes existing
  `/public/tenant` and `/public/branding` behaviour, so it needs a check of
  those callers for any that legitimately need resolution regardless of status
  (e.g. rendering a "this venue is suspended" page rather than a bare 404).
- **(b) Leave the helper; export `TERMINAL_TENANT_STATUSES` and document the
  gap.** Cheaper, but reproduces the exact assumption that caused this — two
  plans already believed the filter existed.

**Recommendation: (a)**, with an explicit opt-out parameter for any caller found
to need the current behaviour.

**Acceptance criteria (for the foundation plan)**

- A suspended/cancelled/archived/deleting tenant's public routes return 404.
- Existing `/public/tenant` and `/public/branding` callers are audited and
  either unchanged or deliberately opted out.
- `pnpm --filter @agora/api rls:proof` and
  `pnpm --filter @agora/chrono-api rls:proof` both pass.

---

## Phase 5 — Validate tenant-authored URLs before they reach a public `href`

`tenant-landing`'s `ctaHref` is unvalidated tenant-authored input rendered into
an anchor on a public page. The module is unbuilt, so this is a constraint its
plan must satisfy rather than a fix to shipped code — but it is recorded here
because it is the same class as the rest of this plan, and because the
`tenant-landing` plan's XSS section explicitly covers the text fields and misses
this one.

**Constraint to add to the `tenant-landing` plan:** `ctaHref` accepts only
`https://` absolute URLs or same-origin relative paths beginning `/`; reuse the
existing `assertPublicHttpsUrl` precedent
(`apps/chrono-api/src/routes/rpc.ts:1579`). The rendered link uses the validated
value only, never raw interpolation.

**Acceptance criteria:** the `tenant-landing` plan's contracts phase names the
refinement and its Phase 5 e2e asserts a `javascript:` value is rejected at the
API, not merely unrendered in the UI.

---

## Verification summary

- `pnpm typecheck` (workspace-wide after Phase 3)
- `pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅`
- `pnpm --filter @agora/chrono-api test:permissions`
- the devices e2e spec (Phase 1)

Every phase's primary assertion is a **negative** one — the request is refused,
the field is absent, the duplicate is rejected. A security phase whose test only
proves the happy path still works has not tested the control.

## Delegation

**No phase is Jules-eligible.** Phase 1 is an unauthenticated auth surface,
Phase 3 closes a credential-exposure path, Phase 4 is a foundation change.
`.ai/rules/feature-planning.md` reserves exactly this for local work with local
verification, and the `jules` skill's guardrail forbids delegating
tenant-isolation code regardless.
