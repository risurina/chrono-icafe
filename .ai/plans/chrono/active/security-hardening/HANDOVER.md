# Security hardening — implementation handover

Tracks `.ai/plans/chrono/active/security-hardening/README.md`.

**No phase is delegated to Jules** — unauthenticated auth surface, credential
exposure, and a foundation change. See the plan's Delegation section.

## Phase status

| Phase | Owner | Status | Notes |
|---|---|---|---|
| 1 — Devices: throttle pairing + unique, high-entropy code | local | not started | highest severity here; run the pre-flight duplicate-code query first |
| 2 — Write down the unauthenticated-route convention | local | not started | docs; the phase that stops the other four recurring |
| 3 — DTO sweep, closes the `qrSecret` path | local | not started | **must land before `qr` Phase 3 populates the column** |
| 4 — Foundation: status-aware `resolveOrgFromRequest` | local | not started | **spec only — create `.ai/plans/agora/active/public-host-status-filter/` before implementing** |
| 5 — Validate tenant-authored URLs (`ctaHref`) | local | not started | constraint for the unbuilt `tenant-landing` plan, not shipped code |

## Log

- 2026-09-02 — Plan created by splitting the security-class phases out of
  `.ai/plans/chrono/active/audit-remediation/` rather than duplicating them.
  `audit-remediation` Phases 3, 6 and 8 were REMOVED there and became Phases 1,
  3 and 4 here; its Phase 9 documentation sweep and its correctness phases stay
  with it. This was done deliberately to avoid the overlapping-ownership defect
  the audit itself found between the `pos` and `reconciliation` plans, where two
  plans both claimed the same lines in `shift/routes.ts:194`. If a finding
  appears in both plans, one of them is wrong — fix the ownership, do not
  implement it twice.
- 2026-09-02 — Rationale for the split, recorded so it is not re-litigated:
  these phases share one reviewer mindset (what does an unauthenticated or
  under-privileged actor get?) and one verification style (negative tests —
  assert the thing is refused). Mixed in with the money-concurrency work they
  read as lower priority than they are. Precedent is `wallet-hardening`, which
  closed one audit's findings in its own plan rather than reopening a completed
  one.
- 2026-09-02 — Phase 4 is deliberately specification-only. Implementing it edits
  `packages/agora`, and `.ai/rules/feature-planning.md` requires a feature
  spanning foundation and business app to be SPLIT into two plans, never filed
  under one app. Doing it from a Chrono plan would repeat exactly the boundary
  violation the `members` audit finding punished (Chrono's `customer:approve`/
  `reject` sitting in `packages/agora/src/auth/permissions.ts`). Create the
  foundation plan first.
- 2026-09-02 — Open decision carried into Phase 1, not yet made: `/pair`
  overwrites the shared provisioning token's `tokenHash` on every redemption,
  so with `maxUses > 1` — the stated golden-image use case — each PC invalidates
  the previous one. Either enforce single-redemption or move minted tokens to
  child rows. Must be decided and written into the `devices` plan as part of
  Phase 1.
- 2026-09-02 — Phase 2 (unauthenticated-route convention doc) landed
  (`ee9ca08`): apps/chrono-api/AGENTS.md now has a full "Unauthenticated
  routes" section naming exact exports and current file:line precedents.
- 2026-09-02 — Phase 3 (DTO sweep, closes qrSecret path) landed
  (`3feeea8`): station/member/loyalty/branch routes now use explicit DTOs,
  no raw Drizzle rows. qrSecret-leak test proved non-vacuous (confirmed
  the secret really existed in the DB row, confirmed it's genuinely
  absent from the route response). typecheck clean (5/5 packages),
  test:permissions 380/380 unchanged.
- 2026-09-02 — Phase 5 (ctaHref validation) landed directly (`954256a`)
  since tenant-landing's contracts.ts already existed — only accepts
  https:// absolute or same-origin relative paths, rejects javascript:.
- 2026-09-02 — Phase 4 (foundation) spec-only plan created at
  `.ai/plans/agora/active/public-host-status-filter/README.md`
  (`d728191`) per feature-planning.md's foundation/business-app split
  rule. NOT implemented — Phase 1 of that plan (audit 11 call sites)
  needs developer input before any code changes, since some call sites
  may legitimately need to keep serving a terminal-status tenant.
