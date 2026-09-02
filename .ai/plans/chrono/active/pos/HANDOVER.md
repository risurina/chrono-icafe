# POS — implementation handover

- 2026-09-01 — Phase 1 (schema, migration, RLS) landed locally and committed
  (`76f5c08`): `ChronoProducts`/`ChronoSales`/`ChronoSaleItems`/`ChronoSalePayments`,
  all four in `APP_TENANT_TABLES`, RLS forced, `rls:proof` PASS.
  `chronoSalePayment.walletTransactionId` shipped as a bare `text` column (no FK) per
  the plan's Cross-module FK sequencing note — `wallet/schema.ts` doesn't exist yet.
- 2026-09-01 — Phase 2 (Zod contracts) delegated to Jules, session
  `9946944973599599619`. Background poller running.
- 2026-09-01 — Session completed. Pulled with `jules remote pull --session
  9946944973599599619 --apply`: only `apps/chrono-api/src/modules/pos/contracts.ts`
  touched, no collision with other in-flight work. Reviewed against Pass 2's spec:
  all listed schemas present (`productStatusSchema`, `productCategorySchema`,
  `saleStatusSchema`, `saleTenderMethodSchema`, `createProductSchema`,
  `updateProductSchema`, `restockProductSchema`, `saleLineInputSchema`,
  `saleTenderInputSchema`, `checkoutSchema`, `refundSaleSchema`,
  `listProductsQuerySchema`, `listSalesQuerySchema`), `saleLineInputSchema`'s refine
  correctly rejects a line with neither `productId` nor `name`+`unitPrice`,
  `checkoutSchema` accepts a mixed cart + split-tender `payments` array as required.
  `pnpm --filter @agora/chrono-api typecheck` clean. Committed (`2bfccba`). Phase 2
  done. Phase 3 (service — stock locking + checkout + refund — + routes + permission
  gates + concurrency proof) is next; per this module's own permission-edit +
  money-path correctness concerns, keep it local, not Jules (same reasoning as
  `wallet`'s own HANDOVER.md header).
- 2026-09-02 — Phase 3 built locally, per Pass 2's exact spec.
  `pos: ["read", "sell", "void", "manageProducts"]` added to the per-app
  extension seam (`apps/chrono-api/src/auth/permissions.ts` — Open Question 1
  resolved per the plan's own recommendation: staff holds read/sell, admin+
  adds void/manageProducts). `service.ts` (`lockAndValidateProducts` —
  ascending-id-order row lock, `checkout` — idempotent on `idempotencyKey`,
  server-side pricing, stock decrement, `debitWallet` for wallet tenders;
  `refundSale` — wallet-portion reversal via `creditWallet`, stock
  restoration, status flip; `calculatePosExpectedCash` for the future
  `reconciliation` module's shift-close wiring), `routes.ts` (products
  CRUD-minus-delete + restock, sales list/detail/checkout/refund, every
  mutating route validating foreign ids inside its own `withTenant` call),
  wired into `rpc.ts`. Added the `pos` gate cases to `permissions.test.ts`
  and a new `concurrency.test.ts` (`test:pos-concurrency`) proving the stock
  row lock against a real Postgres connection: 10 concurrent single-unit
  checkouts against a product with `stockQuantity: 10` → exactly 10 succeed,
  final stock is exactly 0 (never negative), and an 11th checkout correctly
  409s as insufficient stock. `pnpm --filter @agora/chrono-api typecheck`
  clean, `test:permissions` → 349 passed, `rls:proof` → `RLS PROOF: PASS ✅`,
  `test:pos-concurrency` → 3 passed. Committed (`17963ea`). Phase 3 done —
  Phase 4 (shift-close reconciliation wiring) is next.
- 2026-09-02 — Phase 4 (shift-close reconciliation wiring) landed locally,
  committed (`a69b5cc`). Verified against real chrono_test DB: cash sale
  correctly adds to expectedCashAmount, zero-cash-sales shift gets
  expectedCashAmount === openingCashAmount (not null), refunded sales
  excluded. Note: found `chrono_shift_one_open_per_staff_idx` missing
  entirely on the `chrono_test` branch (main dev DB has it correctly, as a
  proper partial index) — confirmed this is a test-tooling gap (ad-hoc DDL
  emitters used by concurrency test scripts don't reconstruct partial
  indexes), not a real migration/production drift. Not fixed, not urgent.
- 2026-09-02 — Phase 5 (web UI) delegated to Jules, session `15794226516510570239`. Backend fully done, fired in parallel with credits/sessions/reports UI.
