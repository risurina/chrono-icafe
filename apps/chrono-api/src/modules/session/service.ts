import { and, eq, withTenant, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { createId } from "agora";
import { getRealtimeProvider, tenantScopeChannel } from "agora/realtime";
import { debitWallet } from "../wallet/service";
import { chronoWallet } from "../wallet/schema";
import { consumeCredits, hasEligibleCreditBalance } from "../credit/service";
import { chronoStation, chronoStationGroup } from "../station/schema";
import { chronoDevice } from "../device/schema";
import { publishStationTransition } from "../station/routes";
import { chronoMemberProfile } from "../member/schema";
import * as base from "agora/db/schema";
import { chronoSession, type ChronoSessionRow } from "./schema";
import { computeMeteredCharge, capMoney } from "./money";
import { chronoSessionStatusSchema, type SessionStateEvent } from "../realtime/contracts";

/**
 * Publishes `session.state` for a session's transition, plus the station's
 * own current `station.status`/`branch.summary` via `publishStationTransition`
 * (realtime-updates plan, Phase 2b) — reusing that helper rather than
 * duplicating its logic, per the "one place computes branch.summary" rule
 * Phase 2a established.
 *
 * Re-reads the station's CURRENT status rather than assuming one: session
 * start/end flip it (available <-> occupied), but pause/resume/extend do
 * NOT touch `chronoStation.status` at all, so this must never guess.
 *
 * MUST be called AFTER the caller's own `withTenant` transaction commits,
 * never from inside it — a publish is not transactional and must not roll
 * back with the write. This is why it takes a plain session row (already
 * committed), not a `TenantTx`.
 */
export async function publishSessionTransition(
  tenantId: string,
  session: Pick<ChronoSessionRow, "id" | "stationId" | "branchId" | "status">,
): Promise<void> {
  const parsedStatus = chronoSessionStatusSchema.safeParse(session.status);
  if (!parsedStatus.success) return;

  const provider = getRealtimeProvider();
  const event: SessionStateEvent = {
    sessionId: session.id,
    stationId: session.stationId,
    status: parsedStatus.data,
  };
  await provider.publish(
    tenantScopeChannel(tenantId, `branch:${session.branchId}`),
    "session.state",
    event,
  );

  // Also target the station's own approved device's private channel
  // (realtime-updates plan, Phase 3) — so a kiosk learns when staff start or
  // end a session at the counter. Looked up fresh at publish time (never
  // cached), so a relink or new approval is reflected on the very next
  // transition with no extra wiring. A station with no approved device (or
  // one still pending_approval) simply gets no second publish — there is no
  // channel to reach.
  const [device] = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: chronoDevice.id })
      .from(chronoDevice)
      .where(and(eq(chronoDevice.stationId, session.stationId), eq(chronoDevice.status, "approved")))
      .limit(1),
  );
  if (device) {
    await provider.publish(tenantScopeChannel(tenantId, `device:${device.id}`), "session.state", event);
  }

  const [station] = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: chronoStation.id, branchId: chronoStation.branchId, status: chronoStation.status })
      .from(chronoStation)
      .where(eq(chronoStation.id, session.stationId))
      .limit(1),
  );
  if (station) {
    await publishStationTransition(tenantId, station);
  }
}

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
    // Zero wallet balance is only a hard block if the member ALSO has no
    // credit grant eligible for this station's group — a member who paid for
    // a minutes package and has nothing left in cash must still be able to
    // start a session (see credit-session-billing plan).
    const hasCredits = await hasEligibleCreditBalance(tx, {
      tenantId: args.tenantId,
      memberId: args.memberId,
      stationGroupId: station.stationGroupId,
    });
    if (!hasCredits) {
      throw new HttpError(422, "Insufficient wallet balance to start a session.");
    }
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
        stationGroupId: station.stationGroupId,
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
  // Credits pay for elapsed time BEFORE any money is billed (credit-session-
  // billing plan): round the elapsed time up to whole minutes (pay for any
  // started minute), draw down the member's eligible ChronoCreditGrants in
  // their existing priority/expiry order, then price only the leftover
  // seconds in money. A member with no grants simply consumes 0 and this is
  // a no-op — identical to today's behavior.
  const creditMinutesElapsed = Math.ceil(billableSeconds / 60);
  const { consumed: creditMinutesConsumed } = await consumeCredits(tx, {
    tenantId: args.tenantId,
    memberId: locked.memberId,
    quantityMinutes: creditMinutesElapsed,
    stationGroupId: locked.stationGroupId,
    reason: `Session ${locked.id}`,
    referenceType: "session",
    referenceId: locked.id,
    performedByUserId: args.performedByUserId ?? undefined,
  });
  const moneyBillableSeconds = Math.max(0, billableSeconds - creditMinutesConsumed * 60);
  const finalAmount = computeMeteredCharge(moneyBillableSeconds, locked.rateSnapshot);

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
      creditMinutesConsumed,
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
