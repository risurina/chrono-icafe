# Audit remediation — implementation handover

Tracks `.ai/plans/chrono/active/audit-remediation/README.md`.

**No phase here is delegated to Jules** — see the plan's Delegation section.
Every phase is a concurrency fix, an authorization change, a credential-exposure
fix, or a foundation edit.

## Phase status

| Phase | Owner | Status | Notes |
|---|---|---|---|
| 1 — POS refund row lock + atomic stock restore | local | not started | highest-severity shipped defect: concurrent refunds double-credit a wallet |
| 2 — Reservations exclusion constraint + reopen plan | local | not started | needs `btree_gist`; run the pre-flight overlap query first |
| 3 — Devices: throttle pairing + unique/high-entropy code | local | not started | two blockers on one unauthenticated endpoint |
| 4 — Shifts: close ownership + row lock | local | not started | adds `shift:closeAny`, admin-only |
| 5 — Move Chrono customer permissions out of `packages/agora` | local | not started | behaviour-preserving ONLY if grants reproduced exactly |
| 6 — DTO sweep (closes latent `qrSecret` exposure) | local | not started | **must land before `qr` Phase 3** |
| 7 — Money helpers + remove float fallbacks | local | not started | adds multiply/subtract/compare to `wallet/money.ts` |
| 8 — Foundation: status-aware `resolveOrgFromRequest` | local | not started | **split to `.ai/plans/agora/` before implementing** — touches `packages/agora` |
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
- 2026-09-02 — Cross-cutting observation worth keeping: `public-stations` and
  `tenant-landing` independently made the SAME wrong assumption about
  `resolveOrgFromRequest` filtering `organization.status`. Two plans converging
  on one false belief points at the helper's contract, not at the plan authors —
  which is why Phase 8 proposes fixing the helper rather than patching both
  call sites.
