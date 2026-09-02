import { eq, and, desc, type TenantTx } from "agora/db";
import { chronoShift } from "./schema";

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
