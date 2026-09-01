import { z } from "zod";
import { listQuerySchema } from "agora";

const MAX_RANGE_DAYS = 366;

export const dateRangeQuerySchema = z
  .object({
    branchId: z.string().min(1).optional(),
    from: z.string().date(), // "YYYY-MM-DD", inclusive, tenant-local calendar day
    to: z.string().date(), // inclusive
  })
  .refine((v) => new Date(v.to) >= new Date(v.from), {
    message: "to must not be before from",
    path: ["to"],
  })
  .refine(
    (v) =>
      (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <=
      MAX_RANGE_DAYS,
    { message: `Range cannot exceed ${MAX_RANGE_DAYS} days.`, path: ["to"] },
  );

export const salesLineQuerySchema = dateRangeQuerySchema.and(
  listQuerySchema(["createdAt", "totalAmount"]),
);

export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

export type SalesSummary = {
  totalRevenue: string;
  saleCount: number;
  averageSaleValue: string;
  byCategory: { category: string; revenue: string; quantity: number }[];
  byPaymentMethod: { method: string; amount: string }[];
  dailySeries: { date: string; revenue: string }[];
};

export type ShiftSummary = {
  shifts: {
    id: string;
    branchId: string;
    staffName: string;
    status: string;
    openingCashAmount: string;
    actualCashAmount: string | null;
    expectedCashAmount: string | null;
    differenceAmount: string | null;
    openedAt: string;
    closedAt: string | null;
  }[];
};

export type WalletActivitySummary = {
  totalCredited: string;
  totalDebited: string;
  netChange: string;
  transactionCount: number;
  dailySeries: { date: string; credited: string; debited: string }[];
};

export type DashboardOverview = {
  today: {
    revenue: string;
    saleCount: number;
    openShiftCount: number;
  };
  trend: { date: string; revenue: string }[];
};
