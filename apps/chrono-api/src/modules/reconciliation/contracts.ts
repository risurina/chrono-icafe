// Per `.ai/rules/dto.md`, outbound API response shapes must be exported as plain TypeScript
// `type` or `interface` declarations (not Zod schemas).

export interface ShiftReconciliationSummary {
  // Null only for a shift closed before this feature shipped (backfilling
  // historical shifts is out of scope — see the reconciliation plan's Out of
  // Scope section). A currently-open shift always gets a live computed value.
  expectedCashAmount: string | null;
  actualCashAmount: string | null;
  differenceAmount: string | null;
}

export interface ShiftReconciliationResponse {
  summary: ShiftReconciliationSummary;
}
