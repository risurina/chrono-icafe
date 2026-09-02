import { eq, and, desc, type TenantTx } from "agora/db";
import { chronoShift } from "./schema";
import { chronoSale, chronoSalePayment } from "../pos/schema";
import { chronoWalletTransaction } from "../wallet/schema";
import { addMoney, subtractMoney } from "../wallet/money";

export async function findOpenShiftForStaff(
  tx: TenantTx,
  args: { tenantId: string; userId: string; branchId?: string },
) {
  const conds = [
    eq(chronoShift.tenantId, args.tenantId),
    eq(chronoShift.staffUserId, args.userId),
    eq(chronoShift.status, "open"),
  ];
  if (args.branchId) {
    conds.push(eq(chronoShift.branchId, args.branchId));
  }

  const [row] = await tx
    .select()
    .from(chronoShift)
    .where(and(...conds))
    .orderBy(desc(chronoShift.openedAt))
    .limit(1);

  return row ?? null;
}

export async function computeExpectedCash(
  tx: TenantTx,
  args: { tenantId: string; shiftId: string; openingCashAmount: string },
): Promise<string> {
  const [completedCashSales, refundedCashSales, walletContributions] = await Promise.all([
    tx
      .select({ amount: chronoSalePayment.amount })
      .from(chronoSalePayment)
      .innerJoin(chronoSale, eq(chronoSalePayment.saleId, chronoSale.id))
      .where(
        and(
          eq(chronoSale.tenantId, args.tenantId),
          eq(chronoSale.shiftId, args.shiftId),
          eq(chronoSalePayment.method, "cash"),
          eq(chronoSale.status, "completed"),
        ),
      ),
    tx
      .select({ amount: chronoSalePayment.amount })
      .from(chronoSalePayment)
      .innerJoin(chronoSale, eq(chronoSalePayment.saleId, chronoSale.id))
      .where(
        and(
          eq(chronoSale.tenantId, args.tenantId),
          eq(chronoSale.shiftId, args.shiftId),
          eq(chronoSalePayment.method, "cash"),
          eq(chronoSale.status, "refunded"),
        ),
      ),
    tx
      .select({ amount: chronoWalletTransaction.amount })
      .from(chronoWalletTransaction)
      .where(
        and(
          eq(chronoWalletTransaction.tenantId, args.tenantId),
          eq(chronoWalletTransaction.shiftId, args.shiftId),
        ),
      ),
  ]);

  const sumCompleted = completedCashSales.reduce((sum, r) => addMoney(sum, r.amount), "0.00");
  const sumRefunded = refundedCashSales.reduce((sum, r) => addMoney(sum, r.amount), "0.00");
  const sumWallet = walletContributions.reduce((sum, r) => addMoney(sum, r.amount), "0.00");

  let expected = addMoney(args.openingCashAmount, sumCompleted);
  expected = subtractMoney(expected, sumRefunded);
  expected = addMoney(expected, sumWallet);

  return expected;
}
