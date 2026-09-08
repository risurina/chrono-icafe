import { eq, and, withTenant, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { getRealtimeProvider, tenantScopeChannel } from "agora/realtime";
import { chronoWallet, chronoWalletTransaction } from "./schema";
import { addMoney, negateMoney, isNegativeMoney, toCents, compareMoney } from "./money";
import { MAX_BALANCE } from "./contracts";
import { chronoSession } from "../session/schema";
import { chronoDevice } from "../device/schema";
import type { WalletLowEvent } from "../realtime/contracts";

/**
 * Ceiling for the resulting balance, matching the `numeric(12, 2)` columns' capacity.
 * The contract layer bounds each individual amount; this bounds the running total,
 * which a series of individually-valid credits could otherwise overflow. Checked as a
 * magnitude because an `adjustment` may legitimately drive the balance negative.
 */
const MAX_BALANCE_CENTS = toCents(MAX_BALANCE);

/**
 * Low-balance push threshold — device-facing "wallet.low" realtime event
 * (pc-client-tauri-api-integration plan, Phase 4). No low-balance UI/threshold
 * exists anywhere in `apps/chrono-web` today (confirmed by grep for
 * "low.?balance"/"threshold" across both apps immediately before this pass —
 * only the member wallet top-up page's own `MIN_TOPUP_AMOUNT` bound exists).
 * Per the plan's own instruction, this does not invent a business-
 * configurable threshold — it hardcodes the same value the member portal's
 * top-up page already treats as the practical floor
 * (`MIN_TOPUP_AMOUNT`/`MIN_WALLET_TOPUP_AMOUNT` = "20.00" in
 * `apps/chrono-web/.../player/wallet/page.tsx` and
 * `apps/chrono-api/.../payment/contracts.ts`), as the nearest existing
 * anchor. Revisit once a real low-balance UI/threshold is designed.
 */
const LOW_BALANCE_THRESHOLD = "20.00";

/**
 * Signal returned by `applyWalletDelta` (and every function that composes
 * it) when a mutation crossed the low-balance threshold — `null` otherwise.
 * The caller that owns the enclosing `withTenant` transaction is responsible
 * for calling `publishWalletLowIfCrossed` with this value AFTER that
 * transaction has committed. See `publishWalletLowIfCrossed`'s doc comment
 * for why this indirection exists.
 */
export type WalletLowSignal = { tenantId: string; memberId: string; balance: string } | null;

/**
 * Publishes `wallet.low` to the owning device's private channel — reuses the
 * exact `tenantScopeChannel(tenantId, \`device:${deviceId}\`)` push pattern
 * `session/service.ts`'s `publishSessionTransition` already established
 * (fresh device lookup at publish time, never cached; no active session on
 * the member, or no approved device on that session's station, simply means
 * no channel to reach — not an error).
 *
 * MUST be called AFTER the caller's own `withTenant` transaction commits,
 * never from inside it — a publish is not transactional and must not roll
 * back with the write (mirrors `publishSessionTransition`'s own rule in
 * `session/service.ts`). This is why `applyWalletDelta` never calls this
 * itself — it returns a `WalletLowSignal` instead, and every call site that
 * owns a `withTenant` block calls `publishWalletLowIfCrossed` once that
 * block has resolved.
 */
export async function publishWalletLow(tenantId: string, memberId: string, balance: string): Promise<void> {
  const [session] = await withTenant(tenantId, (tx) =>
    tx
      .select({ stationId: chronoSession.stationId })
      .from(chronoSession)
      .where(and(eq(chronoSession.memberId, memberId), eq(chronoSession.status, "active")))
      .limit(1),
  );
  if (!session) return;

  const [device] = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: chronoDevice.id })
      .from(chronoDevice)
      .where(and(eq(chronoDevice.stationId, session.stationId), eq(chronoDevice.status, "approved")))
      .limit(1),
  );
  if (!device) return;

  const event: WalletLowEvent = { balance };
  await getRealtimeProvider().publish(
    tenantScopeChannel(tenantId, `device:${device.id}`),
    "wallet.low",
    event,
  );
}

/**
 * Convenience wrapper every post-commit call site uses: no-ops on `null`
 * (no crossing happened), otherwise publishes. Kept as a single function so
 * a call site never has to re-derive the null-check.
 */
export async function publishWalletLowIfCrossed(signal: WalletLowSignal): Promise<void> {
  if (!signal) return;
  await publishWalletLow(signal.tenantId, signal.memberId, signal.balance);
}

/**
 * Locks the member's wallet row for the duration of the caller's transaction,
 * creating it on first use. Every balance mutation in this module funnels
 * through here so the row lock is the single choke point — never a stale
 * pre-transaction read. See .ai/plans/chrono/active/wallet/README.md,
 * "Transaction integrity mechanism."
 */
async function lockWalletForUpdate(tx: TenantTx, tenantId: string, memberId: string) {
  const [existing] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  if (existing) return existing;

  await tx
    .insert(chronoWallet)
    .values({ tenantId, memberId, balance: "0" })
    .onConflictDoNothing({ target: chronoWallet.memberId });

  const [created] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  return created!; // present: either it existed, or the insert (ours or a racing one) won
}

async function applyWalletDelta(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    delta: string; // signed decimal string; positive = increase, negative = decrease
    type: "credit" | "debit" | "adjustment";
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
    allowNegative?: boolean; // debit guard escape hatch — only "adjustment" sets this
    shiftId?: string;
  },
) {
  const wallet = await lockWalletForUpdate(tx, args.tenantId, args.memberId);
  const balanceAfter = addMoney(wallet.balance, args.delta);
  if (!args.allowNegative && isNegativeMoney(balanceAfter)) {
    throw new HttpError(422, "Insufficient wallet balance");
  }

  const balanceAfterCents = toCents(balanceAfter);
  if (balanceAfterCents > MAX_BALANCE_CENTS || balanceAfterCents < -MAX_BALANCE_CENTS) {
    throw new HttpError(422, `Wallet balance limit exceeded (max ${MAX_BALANCE})`);
  }

  const [updatedWallet] = await tx
    .update(chronoWallet)
    .set({ balance: balanceAfter, updatedAt: new Date() })
    .where(eq(chronoWallet.id, wallet.id))
    .returning();

  const [transaction] = await tx
    .insert(chronoWalletTransaction)
    .values({
      tenantId: args.tenantId,
      walletId: wallet.id,
      memberId: args.memberId,
      type: args.type,
      amount: args.delta,
      balanceBefore: wallet.balance,
      balanceAfter,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
      shiftId: args.shiftId,
    })
    .returning();

  // Only on a genuine crossing (was at/above the floor, now below it) —
  // never on every debit that merely stays under an already-low balance, or
  // a member would get re-pushed on every subsequent transaction.
  const crossedLowBalance =
    compareMoney(wallet.balance, LOW_BALANCE_THRESHOLD) >= 0 &&
    compareMoney(balanceAfter, LOW_BALANCE_THRESHOLD) < 0;
  const walletLow: WalletLowSignal = crossedLowBalance
    ? { tenantId: args.tenantId, memberId: args.memberId, balance: balanceAfter }
    : null;

  return { wallet: updatedWallet!, transaction: transaction!, walletLow };
}

/**
 * All three take an already-open `tx`, never opening their own transaction —
 * this is what lets a calling module (e.g. `sessions`) compose a debit into
 * its own atomic operation, per the plan's own "shared surface" note.
 */
export function creditWallet(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    amount: string;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
    shiftId?: string;
  },
) {
  return applyWalletDelta(tx, { ...args, delta: args.amount, type: "credit" });
}

export function debitWallet(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    amount: string;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
    shiftId?: string;
  },
) {
  return applyWalletDelta(tx, {
    ...args,
    delta: negateMoney(args.amount),
    type: "debit",
  });
}

export function adjustWalletBalance(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    delta: string;
    reason: string;
    performedByUserId?: string;
  },
) {
  return applyWalletDelta(tx, { ...args, type: "adjustment", allowNegative: true });
}
