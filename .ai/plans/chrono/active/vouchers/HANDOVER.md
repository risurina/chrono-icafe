# Vouchers — implementation handover

- 2026-09-02 — Phase 2 (Zod contracts) delegated to Jules, session
  `12109467620741648271`, fired ahead of Phase 1 (schema — still not started;
  schema/RLS design stays local, never Jules). Background poller running
  (consolidated with 7 other sessions fired the same round).
- 2026-09-02 — Phase 1 (schema, migration, RLS) landed locally, committed as part of a 9-module batch (`9943aa5`). All 15 new tables registered in APP_TENANT_TABLES, RLS forced, `rls:proof` PASS, whole-workspace typecheck clean.
- 2026-09-02 — Phase 3 (service, routes, permission gates, concurrency test)
  landed locally, committed (`8cb4bd5`). Concurrency test (10 concurrent
  redemptions of the same code) passed deterministically twice: exactly 1
  success, 9 rejections. `test:permissions` 366/0 failed including 5 new
  voucher gate cases. **Phase 4 (POS checkout integration) is now
  unblockable** — pos/routes.ts exists.
- 2026-09-02 — Phase 4 (POS checkout integration) landed as part of a
  combined commit with vouchers/promos/wallet (`5d2f5ff`): checkout
  discount stacking resolved as mutually exclusive (a request with both
  voucherCode and promoCode is rejected 400 before any DB work), loyalty
  auto-earn wired into both a completed POS sale (post-discount amount)
  and a wallet credit. 5/5 integration tests passed against real Postgres.
  Debit/refund point-reversal (Open Question 5) deliberately NOT modeled,
  matching oikos precedent.
- 2026-09-02 — Phase 5 (web UI) delegated to Jules, fired in parallel with the other two modules' Phase 5 sessions. Expect a manual layout.tsx nav-entry merge across all three when pulling.
