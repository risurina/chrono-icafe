import { Hono } from "hono";
import { withTenant, schema as base, eq, and, gte, lte, sql } from "agora/db";
import { requirePermission, hasPermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { chronoBranch } from "../branch/schema";
import { chronoShift } from "../shift/schema";
import { chronoSale, chronoSaleItem, chronoSalePayment } from "../pos/schema";
import { chronoWalletTransaction } from "../wallet/schema";
import { addMoney } from "../wallet/money";
import { dateRangeQuerySchema, salesLineQuerySchema, walletActivityQuerySchema } from "./contracts";
import type { DashboardOverview, SalesSummary, ShiftSummary, WalletActivitySummary } from "./contracts";

/** 404s if `branchId` is set but doesn't belong to this tenant. */
async function requireTenantBranch(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  branchId: string,
) {
  const [row] = await tx
    .select({ id: chronoBranch.id })
    .from(chronoBranch)
    .where(and(eq(chronoBranch.id, branchId), eq(chronoBranch.tenantId, tenantId)))
    .limit(1);
  if (!row) {
    throw new HttpError(404, "Branch not found.");
  }
}

export function reportRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get("/reports/overview", async (c) => {
      requirePermission(c.var.tenant.permissions, { report: ["read"] });
      const { tenantId } = c.var.tenant;
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const overview = await withTenant(tenantId, async (tx) => {
        const dailyRows = await tx
          .select({
            date: sql<string>`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`,
            revenue: sql<string>`coalesce(sum(${chronoSale.totalAmount}), '0.00')`,
          })
          .from(chronoSale)
          .where(and(eq(chronoSale.tenantId, tenantId), eq(chronoSale.status, "completed"), gte(chronoSale.createdAt, since)))
          .groupBy(sql`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`)
          .orderBy(sql`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`);

        const [openShifts] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(chronoShift)
          .where(and(eq(chronoShift.tenantId, tenantId), eq(chronoShift.status, "open")));

        const todayRow = dailyRows.find(
          (r) => r.date === todayStart.toISOString().slice(0, 10),
        );
        const [todaySaleCount] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(chronoSale)
          .where(
            and(
              eq(chronoSale.tenantId, tenantId),
              eq(chronoSale.status, "completed"),
              gte(chronoSale.createdAt, todayStart),
            ),
          );

        const trend = dailyRows.map((r) => ({ date: r.date, revenue: r.revenue }));
        const result: DashboardOverview = {
          today: {
            revenue: todayRow?.revenue ?? "0.00",
            saleCount: todaySaleCount?.value ?? 0,
            openShiftCount: openShifts?.value ?? 0,
          },
          trend,
        };
        return result;
      });

      return c.json(overview);
    })

    .get(
      "/reports/sales-summary",
      zValidator("query", salesLineQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { report: ["read"] });
        const { tenantId } = c.var.tenant;
        const { from, to, branchId } = c.req.valid("query");

        if (!branchId && !hasPermission(c.var.tenant.permissions, { report: ["readFinancial"] })) {
          throw new HttpError(403, "A branchId is required unless you hold report:readFinancial.");
        }

        const summary = await withTenant(tenantId, async (tx) => {
          if (branchId) {
            await requireTenantBranch(tx, tenantId, branchId);
          }
          const saleConds = [
            eq(chronoSale.tenantId, tenantId),
            eq(chronoSale.status, "completed"),
            gte(chronoSale.createdAt, new Date(from)),
            lte(chronoSale.createdAt, new Date(`${to}T23:59:59.999Z`)),
          ];
          if (branchId) saleConds.push(eq(chronoSale.branchId, branchId));
          const where = and(...saleConds);

          const [totals] = await tx
            .select({
              totalRevenue: sql<string>`coalesce(sum(${chronoSale.totalAmount}), '0.00')`,
              saleCount: sql<number>`count(*)::int`,
            })
            .from(chronoSale)
            .where(where);

          const byCategory = await tx
            .select({
              category: chronoSaleItem.name,
              revenue: sql<string>`coalesce(sum(${chronoSaleItem.lineTotal}), '0.00')`,
              quantity: sql<number>`coalesce(sum(${chronoSaleItem.quantity}), 0)::int`,
            })
            .from(chronoSaleItem)
            .innerJoin(chronoSale, eq(chronoSaleItem.saleId, chronoSale.id))
            .where(where)
            .groupBy(chronoSaleItem.name);

          const byPaymentMethod = await tx
            .select({
              method: chronoSalePayment.method,
              amount: sql<string>`coalesce(sum(${chronoSalePayment.amount}), '0.00')`,
            })
            .from(chronoSalePayment)
            .innerJoin(chronoSale, eq(chronoSalePayment.saleId, chronoSale.id))
            .where(where)
            .groupBy(chronoSalePayment.method);

          const dailyRows = await tx
            .select({
              date: sql<string>`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`,
              revenue: sql<string>`coalesce(sum(${chronoSale.totalAmount}), '0.00')`,
            })
            .from(chronoSale)
            .where(where)
            .groupBy(sql`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`)
            .orderBy(sql`to_char(${chronoSale.createdAt}, 'YYYY-MM-DD')`);

          const saleCount = totals?.saleCount ?? 0;
          const totalRevenue = totals?.totalRevenue ?? "0.00";
          const averageSaleValue =
            saleCount > 0 ? (Number(totalRevenue) / saleCount).toFixed(2) : "0.00";

          const result: SalesSummary = {
            totalRevenue,
            saleCount,
            averageSaleValue,
            byCategory: byCategory.map((r) => ({
              category: r.category,
              revenue: r.revenue,
              quantity: r.quantity,
            })),
            byPaymentMethod: byPaymentMethod.map((r) => ({ method: r.method, amount: r.amount })),
            dailySeries: dailyRows.map((r) => ({ date: r.date, revenue: r.revenue })),
          };
          return result;
        });

        return c.json(summary);
      },
    )

    .get(
      "/reports/shift-summary",
      zValidator("query", dateRangeQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { report: ["read"] });
        const { tenantId } = c.var.tenant;
        const { from, to, branchId } = c.req.valid("query");

        if (!branchId && !hasPermission(c.var.tenant.permissions, { report: ["readFinancial"] })) {
          throw new HttpError(403, "A branchId is required unless you hold report:readFinancial.");
        }

        const summary = await withTenant(tenantId, async (tx) => {
          if (branchId) {
            await requireTenantBranch(tx, tenantId, branchId);
          }
          const conds = [
            eq(chronoShift.tenantId, tenantId),
            gte(chronoShift.openedAt, new Date(from)),
            lte(chronoShift.openedAt, new Date(`${to}T23:59:59.999Z`)),
          ];
          if (branchId) conds.push(eq(chronoShift.branchId, branchId));

          const rows = await tx
            .select({
              id: chronoShift.id,
              branchId: chronoShift.branchId,
              staffName: base.user.name,
              status: chronoShift.status,
              openingCashAmount: chronoShift.openingCashAmount,
              actualCashAmount: chronoShift.actualCashAmount,
              expectedCashAmount: chronoShift.expectedCashAmount,
              differenceAmount: chronoShift.differenceAmount,
              openedAt: chronoShift.openedAt,
              closedAt: chronoShift.closedAt,
            })
            .from(chronoShift)
            .innerJoin(base.user, eq(chronoShift.staffUserId, base.user.id))
            .where(and(...conds));

          const result: ShiftSummary = {
            shifts: rows.map((r) => ({
              id: r.id,
              branchId: r.branchId,
              staffName: r.staffName,
              status: r.status,
              openingCashAmount: r.openingCashAmount,
              actualCashAmount: r.actualCashAmount,
              expectedCashAmount: r.expectedCashAmount,
              differenceAmount: r.differenceAmount,
              openedAt: r.openedAt.toISOString(),
              closedAt: r.closedAt ? r.closedAt.toISOString() : null,
            })),
          };
          return result;
        });

        return c.json(summary);
      },
    )

    .get(
      "/reports/wallet-activity",
      zValidator("query", walletActivityQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { report: ["readFinancial"] });
        const { tenantId } = c.var.tenant;
        const { from, to } = c.req.valid("query");

        const summary = await withTenant(tenantId, async (tx) => {
          const where = and(
            eq(chronoWalletTransaction.tenantId, tenantId),
            gte(chronoWalletTransaction.createdAt, new Date(from)),
            lte(chronoWalletTransaction.createdAt, new Date(`${to}T23:59:59.999Z`)),
          );

          const rows = await tx
            .select({ type: chronoWalletTransaction.type, amount: chronoWalletTransaction.amount })
            .from(chronoWalletTransaction)
            .where(where);

          let totalCredited = "0.00";
          let totalDebited = "0.00";
          for (const r of rows) {
            if (Number(r.amount) > 0) totalCredited = addMoney(totalCredited, r.amount);
            else totalDebited = addMoney(totalDebited, r.amount);
          }

          const dailyRows = await tx
            .select({
              date: sql<string>`to_char(${chronoWalletTransaction.createdAt}, 'YYYY-MM-DD')`,
              credited: sql<string>`coalesce(sum(case when ${chronoWalletTransaction.amount}::numeric > 0 then ${chronoWalletTransaction.amount}::numeric else 0 end), 0)::text`,
              debited: sql<string>`coalesce(sum(case when ${chronoWalletTransaction.amount}::numeric < 0 then ${chronoWalletTransaction.amount}::numeric else 0 end), 0)::text`,
            })
            .from(chronoWalletTransaction)
            .where(where)
            .groupBy(sql`to_char(${chronoWalletTransaction.createdAt}, 'YYYY-MM-DD')`)
            .orderBy(sql`to_char(${chronoWalletTransaction.createdAt}, 'YYYY-MM-DD')`);

          const result: WalletActivitySummary = {
            totalCredited,
            totalDebited,
            netChange: addMoney(totalCredited, totalDebited),
            transactionCount: rows.length,
            dailySeries: dailyRows.map((r) => ({
              date: r.date,
              credited: r.credited,
              debited: r.debited,
            })),
          };
          return result;
        });

        return c.json(summary);
      },
    );
}
