import { Hono } from "hono";
import { withTenant, eq, and } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError } from "agora/server";
import { chronoShift } from "../shift/schema";
import { computeExpectedCash } from "../shift/service";
import { type ShiftReconciliationResponse } from "./contracts";

export function reconciliationRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get("/shifts/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { reconciliation: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const response = await withTenant(tenantId, async (tx) => {
        const [shift] = await tx
          .select({
            id: chronoShift.id,
            status: chronoShift.status,
            openingCashAmount: chronoShift.openingCashAmount,
            expectedCashAmount: chronoShift.expectedCashAmount,
            actualCashAmount: chronoShift.actualCashAmount,
            differenceAmount: chronoShift.differenceAmount,
          })
          .from(chronoShift)
          .where(and(eq(chronoShift.id, id), eq(chronoShift.tenantId, tenantId)))
          .limit(1);

        if (!shift) {
          throw new HttpError(404, "Shift not found.");
        }

        if (shift.status === "open") {
          const liveExpectedCash = await computeExpectedCash(tx, {
            tenantId,
            shiftId: shift.id,
            openingCashAmount: shift.openingCashAmount,
          });

          const result: ShiftReconciliationResponse = {
            summary: {
              expectedCashAmount: liveExpectedCash,
              actualCashAmount: null,
              differenceAmount: null,
            },
          };
          return result;
        } else {
          // For closed shifts, return the persisted figures as-is — null
          // means this shift closed before this feature shipped (see
          // ShiftReconciliationSummary), never coerced to a fabricated 0.00.
          const result: ShiftReconciliationResponse = {
            summary: {
              expectedCashAmount: shift.expectedCashAmount,
              actualCashAmount: shift.actualCashAmount,
              differenceAmount: shift.differenceAmount,
            },
          };
          return result;
        }
      });

      return c.json(response);
    });
}
