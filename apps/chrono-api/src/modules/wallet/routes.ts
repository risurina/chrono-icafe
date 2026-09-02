import { Hono } from "hono";
import {
  withTenant,
  schema as base,
  eq,
  or,
  ilike,
  desc,
  asc,
  count,
  type TenantTx,
} from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { listQuerySchema } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoWallet, chronoWalletTransaction } from "./schema";
import { creditWallet, debitWallet, adjustWalletBalance } from "./service";
import { creditWalletSchema, debitWalletSchema, adjustWalletSchema } from "./contracts";
import { earnLoyaltyPoints } from "../loyalty/service";

function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    endItem: Math.min(page * pageSize, totalItems),
    sort,
    order,
  };
}

/** A financial audit trail is only useful if the amount is in it — an entry naming
 * only the wallet forces an investigator to join back to the ledger by timestamp.
 * Mirrors the metadata shape `modules/reservation/routes.ts` already uses. */
function walletAuditMetadata(
  memberId: string,
  result: {
    transaction: {
      id: string;
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
      reason: string;
    };
  },
) {
  return {
    memberId,
    transactionId: result.transaction.id,
    amount: result.transaction.amount,
    balanceBefore: result.transaction.balanceBefore,
    balanceAfter: result.transaction.balanceAfter,
    reason: result.transaction.reason,
  };
}

/** 404s if `memberId` does not belong to this tenant — closes the isolation hole
 * where a mutation could otherwise be attempted against a foreign member id. */
async function requireTenantMember(tx: TenantTx, memberId: string) {
  const [row] = await tx
    .select({ id: base.tenantMember.id })
    .from(base.tenantMember)
    .where(eq(base.tenantMember.id, memberId))
    .limit(1);
  if (!row) {
    throw new HttpError(404, "Member not found.");
  }
}

export function walletRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/wallets",
      zValidator("query", listQuerySchema(["balance", "createdAt"])),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { wallet: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, q } = c.req.valid("query");
        const sortCol =
          sort === "balance" ? chronoWallet.balance : chronoWallet.createdAt;
        const sortFn = order === "asc" ? asc : desc;
        // Applied to the count query as well as the rows query — otherwise
        // `meta.totalItems` would describe the unfiltered set and the pagination
        // controls would disagree with what the table shows.
        const search = q
          ? or(
              ilike(base.tenantMember.name, `%${q}%`),
              ilike(base.tenantMember.email, `%${q}%`),
            )
          : undefined;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoWallet)
            .innerJoin(base.tenantMember, eq(chronoWallet.memberId, base.tenantMember.id))
            .where(search);
          const rows = await tx
            .select({
              id: chronoWallet.id,
              memberId: chronoWallet.memberId,
              memberName: base.tenantMember.name,
              memberEmail: base.tenantMember.email,
              balance: chronoWallet.balance,
              currency: chronoWallet.currency,
              createdAt: chronoWallet.createdAt,
              updatedAt: chronoWallet.updatedAt,
            })
            .from(chronoWallet)
            .innerJoin(base.tenantMember, eq(chronoWallet.memberId, base.tenantMember.id))
            .where(search)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .get("/wallets/:memberId", async (c) => {
      requirePermission(c.var.tenant.permissions, { wallet: ["read"] });
      const { tenantId } = c.var.tenant;
      const memberId = c.req.param("memberId");

      const wallet = await withTenant(tenantId, async (tx) => {
        await requireTenantMember(tx, memberId);
        const [row] = await tx
          .select()
          .from(chronoWallet)
          .where(eq(chronoWallet.memberId, memberId))
          .limit(1);
        return row ?? null;
      });

      return c.json({
        wallet: wallet ?? { memberId, balance: "0.00", currency: "PHP", exists: false },
      });
    })

    .get(
      "/wallets/:memberId/transactions",
      zValidator("query", listQuerySchema(["createdAt"])),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { wallet: ["read"] });
        const { tenantId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          const [total] = await tx
            .select({ value: count() })
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId));
          const rows = await tx
            .select()
            .from(chronoWalletTransaction)
            .where(eq(chronoWalletTransaction.memberId, memberId))
            .orderBy(sortFn(chronoWalletTransaction.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post(
      "/wallets/:memberId/credit",
      zValidator("json", creditWalletSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { wallet: ["credit"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          const creditResult = await creditWallet(tx, {
            tenantId,
            memberId,
            amount: input.amount,
            reason: input.reason ?? "Manual top-up",
            referenceType: input.referenceType,
            performedByUserId: userId,
          });
          // Auto-earn on a wallet top-up — no symmetric reversal on debit/
          // refund (developer decision, loyalty Open Question 5).
          await earnLoyaltyPoints(tx, {
            tenantId,
            memberId,
            spendAmount: input.amount,
            referenceType: "wallet_transaction",
            referenceId: creditResult.transaction.id,
          });
          return creditResult;
        });

        await recordStaffAudit(c, {
          action: "chronoWallet.credited",
          targetType: "wallet",
          targetId: result.wallet.id,
          metadata: walletAuditMetadata(memberId, result),
        });
        return c.json(result);
      },
    )

    .post(
      "/wallets/:memberId/debit",
      zValidator("json", debitWalletSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { wallet: ["debit"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return debitWallet(tx, {
            tenantId,
            memberId,
            amount: input.amount,
            reason: input.reason,
            referenceType: input.referenceType,
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoWallet.debited",
          targetType: "wallet",
          targetId: result.wallet.id,
          metadata: walletAuditMetadata(memberId, result),
        });
        return c.json(result);
      },
    )

    .post(
      "/wallets/:memberId/adjust",
      zValidator("json", adjustWalletSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { wallet: ["adjust"] });
        const { tenantId, userId } = c.var.tenant;
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const result = await withTenant(tenantId, async (tx) => {
          await requireTenantMember(tx, memberId);
          return adjustWalletBalance(tx, {
            tenantId,
            memberId,
            delta: input.delta,
            reason: input.reason,
            performedByUserId: userId,
          });
        });

        await recordStaffAudit(c, {
          action: "chronoWallet.adjusted",
          targetType: "wallet",
          targetId: result.wallet.id,
          metadata: walletAuditMetadata(memberId, result),
        });
        return c.json(result);
      },
    );
}
