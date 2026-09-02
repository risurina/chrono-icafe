# Reports — implementation handover

- 2026-09-02 — Phase 1 (Zod contracts — this module is schema-free, a
  read-only aggregation layer over pos/wallet/shift tables) delegated to
  Jules, session `9092477127910247974`. Background poller running
  (consolidated with 7 other sessions fired the same round).
- 2026-09-02 — Phase 4 (web UI) delegated to Jules, session `14114523439751067063`. Fired in parallel with pos/credits/sessions UI.
- 2026-09-02 — Phase 2 (permission registration) + Phase 3 (routes) built
  locally, per Pass 2's exact spec. `report: ["read", "readFinancial"]`
  added to the per-app extension seam — staff holds `read` only, admin+
  adds `readFinancial`. `routes.ts`: four GET-only aggregation routes
  (`overview`, `sales-summary`, `shift-summary`, `wallet-activity`), each
  resolving/404ing a `branchId` inside `withTenant` before aggregating, the
  "no branchId requires report:readFinancial" inline `hasPermission` check
  on `sales-summary`/`shift-summary` (gated on the resolved permission set,
  never the role name, per `.ai/rules/rbac.md`), wired into `rpc.ts`.
  **Fixed a real bug in the plan's own Pass 2 spec**: it calls
  `dateRangeQuerySchema.omit({ branchId: true })` for `wallet-activity`, but
  Zod v4 refuses `.omit()` on a schema with `.refine()`s (which
  `dateRangeQuerySchema` has, for range-validity checks) — throws at import
  time, not just a type error. Fixed by adding a separate
  `walletActivityQuerySchema` in `contracts.ts` that duplicates the two
  range refinements instead of deriving via `.omit()`. Added the `report`
  gate cases to `permissions.test.ts` (staff read-only, admin+
  readFinancial, deny-by-default) and a new `aggregation.test.ts`
  (`test:report-aggregation`, PGlite-based — this is a read-only module, no
  concurrency to prove) driving the real HTTP routes end to end: seeded
  tenant A (one branch/shift/sale/sale-item/sale-payment/wallet-transaction)
  and an empty tenant B, asserted `sales-summary`/`shift-summary` match the
  seeded aggregates exactly, `wallet-activity` totals match, a cross-tenant
  `branchId` 404s (not an empty/zeroed report), and an empty tenant returns
  zeroed aggregates rather than a 500/crash. `pnpm --filter @agora/chrono-api
  typecheck` clean, `test:permissions` → 385 passed, `rls:proof` → `RLS
  PROOF: PASS ✅`, `test:report-aggregation` → 8 passed. Committed
  (`afa8687`). Phases 2+3 done — **`reports` backend is now complete,
  the last remaining module backend gap in the whole migration is closed.**
