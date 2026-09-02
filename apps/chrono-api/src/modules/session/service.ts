import { and, eq, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { createId } from "agora";
import { debitWallet } from "../wallet/service";
import { chronoWallet } from "../wallet/schema";
import { chronoStation, chronoStationGroup } from "../station/schema";
import { chronoMemberProfile } from "../member/schema";
import * as base from "agora/db/schema";
import { chronoSession, type ChronoSessionRow } from "./schema";
import { computeMeteredCharge, capMoney } from "./money";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

/**
 * The ONLY code path that starts a session — called by both the staff
 * POST /rpc/sessions route (permission-gated, `startedByUserId` = the acting
 * staff member) and the QR self-service consume flow (`startedByUserId` =
 * null, the member starts their own session by scanning their own station's
 * code). Callers are responsible for their own authorization — this
 * function only enforces the underlying business invariants (station
 * available + priced, member active, wallet funded).
 */
export async function startSession(
  tx: TenantTx,
  args: {
    tenantId: string;
    stationId: string;
    memberId: string;
    durationMinutes?: number;
    startedByUserId: string | null;
  },
): Promise<ChronoSessionRow> {
  const [station] = await tx
    .select()
    .from(chronoStation)
    .where(and(eq(chronoStation.id, args.stationId), eq(chronoStation.tenantId, args.tenantId)))
    .limit(1);
  if (!station) {
    throw new HttpError(404, "Station not found.");
  }
  if (station.status !== "available") {
    throw new HttpError(409, "STATION_OCCUPIED");
  }
  if (!station.stationGroupId) {
    throw new HttpError(
      400,
      "This station has no pricing group — assign one in Stations → Groups & Rates before starting a session.",
    );
  }
  const [group] = await tx
    .select()
    .from(chronoStationGroup)
    .where(eq(chronoStationGroup.id, station.stationGroupId))
    .limit(1);
  if (!group) {
    throw new HttpError(
      400,
      "This station has no pricing group — assign one in Stations → Groups & Rates before starting a session.",
    );
  }

  const [member] = await tx
    .select({ id: base.tenantMember.id })
    .from(base.tenantMember)
    .where(and(eq(base.tenantMember.id, args.memberId), eq(base.tenantMember.tenantId, args.tenantId)))
    .limit(1);
  if (!member) {
    throw new HttpError(404, "Member not found.");
  }
  const [tenantMemberRow] = await tx
    .select({ status: base.tenantMember.status })
    .from(base.tenantMember)
    .where(eq(base.tenantMember.id, args.memberId))
    .limit(1);
  if (tenantMemberRow?.status !== "active") {
    throw new HttpError(409, "This member's account is not active.");
  }

  // Rate resolution: memberRate only if the group has one set AND the
  // customer holds an approved ChronoMemberProfiles row.
  let rateSnapshot = group.hourlyRate;
  let rateSource: "group_hourly" | "group_member" = "group_hourly";
  if (group.memberRate) {
    const [profile] = await tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(eq(chronoMemberProfile.memberId, args.memberId))
      .limit(1);
    if (profile?.applicationStatus === "approved") {
      rateSnapshot = group.memberRate;
      rateSource = "group_member";
    }
  }

  const [wallet] = await tx
    .select({ balance: chronoWallet.balance })
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, args.memberId))
    .limit(1);
  const balance = wallet?.balance ?? "0.00";
  if (Number(balance) <= 0) {
    throw new HttpError(422, "Insufficient wallet balance to start a session.");
  }

  const scheduledEndAt = args.durationMinutes
    ? new Date(Date.now() + args.durationMinutes * 60_000)
    : null;

  let row;
  try {
    [row] = await tx
      .insert(chronoSession)
      .values({
        id: createId(),
        tenantId: args.tenantId,
        branchId: station.branchId,
        stationId: station.id,
        memberId: args.memberId,
        startedByUserId: args.startedByUserId,
        status: "active",
        scheduledEndAt,
        rateSnapshot,
        rateSource,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "STATION_OCCUPIED");
    }
    throw err;
  }

  await tx
    .update(chronoStation)
    .set({ status: "occupied", updatedAt: new Date() })
    .where(eq(chronoStation.id, station.id));

  return row!;
}

/**
 * The ONLY code path that transitions a session to "ended" — called by both
 * the manual POST /:id/end route and the background expiry sweep (Phase 4),
 * so there is exactly one implementation of the billing-closure logic.
 *
 * Row-locks the session for the duration of the caller's transaction (same
 * discipline as wallet's own lockWalletForUpdate) so a racing caller (manual
 * end vs. the expiry sweep) blocks until the winner commits, then sees the
 * row already `ended` and returns alreadyClosed: true — never a double-close
 * or a double wallet debit, since billing is only ever computed AFTER the
 * lock is held.
 */
export async function closeSession(
  tx: TenantTx,
  args: { tenantId: string; sessionId: string; performedByUserId: string | null },
): Promise<{ session: ChronoSessionRow; alreadyClosed: boolean }> {
  const now = new Date();

  const [locked] = await tx
    .select()
    .from(chronoSession)
    .where(and(eq(chronoSession.id, args.sessionId), eq(chronoSession.tenantId, args.tenantId)))
    .for("update");
  if (!locked) {
    throw new HttpError(404, "Session not found.");
  }
  if (!["active", "paused"].includes(locked.status)) {
    return { session: locked, alreadyClosed: true };
  }

  // Billable seconds = wall-clock elapsed since start, minus accumulated
  // paused time, minus the still-open pause segment if closing while paused.
  const pausedNow =
    locked.status === "paused" && locked.pausedAt
      ? Math.floor((now.getTime() - locked.pausedAt.getTime()) / 1000)
      : 0;
  const billableSeconds = Math.max(
    0,
    Math.floor((now.getTime() - locked.startedAt.getTime()) / 1000) -
      locked.pausedDurationSeconds -
      pausedNow,
  );
  const finalAmount = computeMeteredCharge(billableSeconds, locked.rateSnapshot);

  const [wallet] = await tx
    .select({ balance: chronoWallet.balance })
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, locked.memberId));
  const walletBalance = wallet?.balance ?? "0.00";
  const amountCharged = capMoney(finalAmount, walletBalance);

  let walletTransactionId: string | null = null;
  if (Number(amountCharged) > 0) {
    const { transaction } = await debitWallet(tx, {
      tenantId: args.tenantId,
      memberId: locked.memberId,
      amount: amountCharged,
      reason: `Session ${locked.id}`,
      referenceType: "session",
      referenceId: locked.id,
      performedByUserId: args.performedByUserId ?? undefined,
    });
    walletTransactionId = transaction.id;
  }

  const [session] = await tx
    .update(chronoSession)
    .set({
      status: "ended",
      endedAt: now,
      actualBillableSeconds: billableSeconds,
      finalAmount,
      amountCharged,
      walletTransactionId,
      updatedAt: now,
    })
    .where(eq(chronoSession.id, locked.id))
    .returning();

  await tx
    .update(chronoStation)
    .set({ status: "available", updatedAt: now })
    .where(eq(chronoStation.id, locked.stationId));

  return { session: session!, alreadyClosed: false };
}
