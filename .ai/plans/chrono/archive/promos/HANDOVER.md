# Promos — implementation handover

- 2026-09-02 — Phase 2 (Zod contracts) delegated to Jules, session
  `11191004794355357381`, fired ahead of Phase 1 (schema — still not started;
  schema/RLS design stays local, never Jules). Background poller running
  (consolidated with 7 other sessions fired the same round).
- 2026-09-02 — Phase 1 (schema, migration, RLS) landed locally, committed as part of a 9-module batch (`9943aa5`). All 15 new tables registered in APP_TENANT_TABLES, RLS forced, `rls:proof` PASS, whole-workspace typecheck clean.
- 2026-09-02 — Phase 3 (service, routes, permission gates, concurrency test)
  landed locally, committed (`b302c52`). Concurrency test (10 concurrent
  redemptions against maxRedemptions:1) passed deterministically twice:
  exactly 1 success, 9 rejected. `test:permissions` 371/0 failed including
  5 new promo gate cases (staff denied manage, admin/owner allowed).
  **Phase 4 (POS checkout integration) is now unblockable** —
  pos/routes.ts exists. Must coordinate with vouchers' own Phase 4 on the
  discount-stacking-rules open question — both touch the same checkout
  transaction.
- 2026-09-02 — Phase 4 (POS checkout integration) landed as part of a
  combined commit with vouchers/promos/wallet (`5d2f5ff`): checkout
  discount stacking resolved as mutually exclusive (a request with both
  voucherCode and promoCode is rejected 400 before any DB work), loyalty
  auto-earn wired into both a completed POS sale (post-discount amount)
  and a wallet credit. 5/5 integration tests passed against real Postgres.
  Debit/refund point-reversal (Open Question 5) deliberately NOT modeled,
  matching oikos precedent.
- 2026-09-02 — Phase 5 (web UI) delegated to Jules, fired in parallel with the other two modules' Phase 5 sessions. Expect a manual layout.tsx nav-entry merge across all three when pulling.
- 2026-09-02 — Phase 5 (web UI) session `2376761933710073487` stalled on a
  Google sign-in wall (same issue as wallet's own Phase 4) — discarded,
  built locally instead. See commit once it lands.
- 2026-09-02 — Built locally instead (session `2376761933710073487`
  discarded per developer direction). Committed (`5610d3a`), zero
  any-types, typecheck+build clean. **Phase 5 done, Phase 6 (e2e) next.**
- 2026-09-02 — Phase 6 (e2e spec) delegated to Jules, session `10373575048047962490`. Fired in parallel with loyalty/vouchers Phase 6.
- 2026-09-02 — Session `10373575048047962490` pulled: fixed 3 explicit
  `any` callback annotations locally. typecheck clean. Committed. **All 6
  phases of promos are now done** (e2e not yet headed-run).
- 2026-09-02 — Archived (all 6 phases complete).
