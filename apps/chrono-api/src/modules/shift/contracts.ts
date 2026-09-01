import { z } from "zod";
import { listQuerySchema } from "agora";

export const shiftStatusSchema = z.enum(["open", "closed"]);

// Decimal-string money, matching oikos's own wire format (precision-safe,
// database.md: numeric/decimal, never floating point).
const moneyStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount format");

export const openShiftSchema = z.object({
  branchId: z.string().min(1),
  openingCashAmount: moneyStringSchema,
  notes: z.string().max(1000).optional(),
});

export const closeShiftSchema = z.object({
  actualCashAmount: moneyStringSchema,
  notes: z.string().max(1000).optional(),
});

export const listShiftsQuerySchema = listQuerySchema(["openedAt", "closedAt"]).extend({
  branchId: z.string().optional(),
  status: shiftStatusSchema.optional(),
});

export type OpenShiftInput = z.infer<typeof openShiftSchema>;
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
