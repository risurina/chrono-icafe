# Audit remediation — implementation handover

Tracks `.ai/plans/chrono/active/audit-remediation/README.md`.

**No phase here is delegated to Jules** — see the plan's Delegation section.
Every phase is a concurrency fix, an authorization change, or a foundation edit.

**Phase numbers 3, 6 and 8 are intentionally missing.** They moved to
`.ai/plans/chrono/active/security-hardening/` (as its Phases 1, 3 and 4).
The remaining phases are NOT renumbered, so `f756dca`'s "Phase 1" and every
reference below stay valid.

## Phase status

| Phase | Owner | Status | Notes |
|---|---|---|---|
| 1 — POS refund row lock + atomic stock restore | local | done | committed `f756dca`; negative test confirmed the bug was real (see log) |
| 2 — Reservations exclusion constraint + reopen plan | local | not started | needs `btree_gist`; run the pre-flight overlap query first |
| 4 — Shifts: close ownership + row lock | local | not started | adds `shift:closeAny`, admin-only |
| 5 — Move Chrono customer permissions out of `packages/agora` | local | not started | behaviour-preserving ONLY if grants reproduced exactly |
| 7 — Money helpers + remove float fallbacks | local | not started | adds multiply/subtract/compare to `wallet/money.ts` |
| 9 — Documentation sweep (9a–9e) | local | not started | one commit per pattern |

## Log

- 2026-09-02 — Plan written from a full audit of all 22 Chrono plans, one
  independent agent per plan. Each agent was required to establish
  implementation state from `git` itself rather than from a status table or any
  snapshot passed into its prompt — a precaution added after the earlier
  `wallet` audit produced two false blockers by trusting a stale pre-`74a6881`
  snapshot. Verdicts: 8 APPROVED WITH CONDITIONS (`branches`, `stations`,
  `members`, `devices`, `loyalty`, `reports`, `realtime-updates`,
  `wallet-hardening`), 14 NEEDS REVISION. No plan was clean. `members` and
  `devices` carry blockers despite an "approved" verdict — the verdict reflected
  that the module is built and structurally sound, not that nothing needed
  fixing.
- 2026-09-02 — Note on scope: this plan owns cross-module remediation only. The
  largest single plan defect found — `reconciliation`'s expected-cash formula,
  wrong twice in one expression — is deliberately NOT owned here, because that
  module is unbuilt and the fix belongs in its own plan before code exists. Same
  for `sessions`' lock-ordering and unlocked-balance-read defects. See
  "Delegated back" in the README so these are not lost.
- 2026-09-02 — `wallet-hardening` was audited adversarially on the explicit
  ground that it was written and implemented by the same session (self-marked
  homework). It came back APPROVED WITH CONDITIONS with no new defects
  introduced and findings (a)–(g) confirmed genuinely closed. Its two open
  conditions are inherited, not introduced: the `test:wallet-concurrency` re-run
  still owed, and the `wallet` e2e spec that neither plan closes.
- 2026-09-02 — Phase 1 done, committed `f756dca`. `refundSale` now takes
  `.for("update")` on the `chronoSale` row as its first statement and re-checks
  `status` under the lock; stock restore became an in-place
  `stockQuantity + n` SQL update (no read-then-write) and was moved BEFORE the
  `creditWallet` call, so the wallet lock is acquired last per the wallet
  module's lock-ordering rule. Added a refund double-submit case to
  `concurrency.test.ts`.
  **The negative test was run deliberately and the defect was confirmed real
  and severe**: with `.for("update")` removed, all 10 concurrent refunds
  succeeded, the member's wallet went 90.00 → 190.00 instead of 100.00 (ten
  times the refund amount credited from nothing), and stock restored to 14
  instead of 5. Lock restored, suite green at 6 passed / 0 failed. This is the
  discipline `.ai/rules/rbac.md` requires of gate tests — a test that passes
  either way is testing plumbing, not the guard — applied here to a concurrency
  guard.
  Note: `pnpm --filter @agora/chrono-api typecheck` currently reports two
  TS6133 unused-import errors in `src/modules/voucher/routes.ts`, a file
  another session is writing concurrently (vouchers Phase 3). Not from this
  work; the pos and wallet modules typecheck clean. Do not "fix" that file
  from this plan.
- 2026-09-02 — Cross-cutting observation worth keeping: `public-stations` and
  `tenant-landing` independently made the SAME wrong assumption about
  `resolveOrgFromRequest` filtering `organization.status`. Two plans converging
  on one false belief points at the helper's contract, not at the plan authors —
  which is why the remedy fixes the helper rather than patching both call sites.
  That work is now `security-hardening` Phase 4.
- 2026-09-02 — Split: the security-class phases (3 devices, 6 DTO/`qrSecret`,
  8 public-host status filter) moved to
  `.ai/plans/chrono/active/security-hardening/` and were REMOVED here, rather
  than duplicated. This is a direct application of a finding from the audit
  itself — the `pos` and `reconciliation` plans both claimed ownership of the
  same lines in `shift/routes.ts:194`, and that ambiguity is what let the
  `shifts` plan keep asserting `expectedCashAmount` is "always null" after
  `a69b5cc` made it real. One owner per finding.
