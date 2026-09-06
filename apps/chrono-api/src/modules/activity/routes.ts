import { Hono } from "hono";
import { unionAll } from "drizzle-orm/pg-core";
import { withTenant, eq, and, ilike, asc, desc, count, sql, type TenantTx } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator } from "agora/server";
import { buildPaginationMeta } from "agora";
import { chronoWalletTransaction } from "../wallet/schema";
import { chronoCreditGrantLedgerEntry } from "../credit/schema";
import { chronoSession } from "../session/schema";
import { chronoReservation } from "../reservation/schema";
import { chronoStation } from "../station/schema";
import { activityListQuerySchema, type ActivityEventType } from "./contracts";

/**
 * Customer-facing unified activity feed — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`, mirroring every other
 * `/portal/*` route. Mounted at `/portal/activity` (apps/chrono-api/src/app.ts).
 *
 * Each of the four branches below is scoped BOTH by an explicit
 * `tenantId` filter AND `withTenant`'s RLS session-scoping AND an explicit
 * `memberId` filter — belt-and-suspenders, deliberately more defensive than
 * a bare `memberId`-only filter (some sibling portal routes rely on RLS
 * alone), because a UNION spanning four tables is exactly the shape where a
 * missed filter on ONE branch would leak cross-tenant/cross-member rows
 * while the other three look correct in isolation. Never trust
 * `c.req.query` for either id — both come from `c.var.member`.
 */

type BranchArgs = { tenantId: string; memberId: string; q?: string };

function walletBranch(tx: TenantTx, { tenantId, memberId, q }: BranchArgs) {
  const conditions = [
    eq(chronoWalletTransaction.tenantId, tenantId),
    eq(chronoWalletTransaction.memberId, memberId),
  ];
  if (q) conditions.push(ilike(chronoWalletTransaction.reason, `%${q}%`));
  return tx
    .select({
      id: chronoWalletTransaction.id,
      type: sql<string>`'wallet'`.as("type"),
      occurredAt: chronoWalletTransaction.createdAt,
      title: sql<string>`case ${chronoWalletTransaction.type}
        when 'credit' then 'Wallet top-up'
        when 'debit' then 'Wallet debit'
        else 'Wallet adjustment'
      end`.as("title"),
      description: chronoWalletTransaction.reason,
      // Cast to nullable to match the other three branches' `amount` column
      // type exactly — Drizzle's `unionAll` requires identical result types
      // across branches, and only wallet's own `amount` column is NOT NULL.
      amount: sql<string | null>`${chronoWalletTransaction.amount}`.as("amount"),
      status: sql<string | null>`null::text`.as("status"),
    })
    .from(chronoWalletTransaction)
    .where(and(...conditions));
}

function creditBranch(tx: TenantTx, { tenantId, memberId, q }: BranchArgs) {
  const conditions = [
    eq(chronoCreditGrantLedgerEntry.tenantId, tenantId),
    eq(chronoCreditGrantLedgerEntry.memberId, memberId),
  ];
  if (q) {
    conditions.push(
      sql`coalesce(${chronoCreditGrantLedgerEntry.reason}, '') ilike ${`%${q}%`}`,
    );
  }
  return tx
    .select({
      id: chronoCreditGrantLedgerEntry.id,
      type: sql<string>`'credit'`.as("type"),
      occurredAt: chronoCreditGrantLedgerEntry.createdAt,
      title: sql<string>`case ${chronoCreditGrantLedgerEntry.type}
        when 'granted' then 'Credits granted'
        when 'consumed' then 'Credits used'
        when 'expired' then 'Credits expired'
        when 'voided' then 'Credits voided'
        when 'adjusted' then 'Credits adjusted'
        else 'Credit activity'
      end`.as("title"),
      // No money column on this ledger (it moves minutes, not currency) — the
      // quantity delta is folded into the description text instead of the
      // `amount` field, which stays money-only across every branch.
      description: sql<string>`coalesce(
        ${chronoCreditGrantLedgerEntry.reason},
        (${chronoCreditGrantLedgerEntry.quantityDelta})::text || ' min'
      )`.as("description"),
      amount: sql<string | null>`null::numeric`.as("amount"),
      status: chronoCreditGrantLedgerEntry.type,
    })
    .from(chronoCreditGrantLedgerEntry)
    .where(and(...conditions));
}

function sessionBranch(tx: TenantTx, { tenantId, memberId, q }: BranchArgs) {
  const conditions = [
    eq(chronoSession.tenantId, tenantId),
    eq(chronoSession.memberId, memberId),
  ];
  if (q) conditions.push(ilike(chronoStation.name, `%${q}%`));
  return tx
    .select({
      id: chronoSession.id,
      type: sql<string>`'session'`.as("type"),
      occurredAt: chronoSession.startedAt,
      title: sql<string>`'Gaming session at ' || ${chronoStation.name}`.as("title"),
      description: sql<string>`case ${chronoSession.status}
        when 'ended' then 'Completed session'
        when 'active' then 'Session in progress'
        when 'paused' then 'Session paused'
        else ${chronoSession.status}
      end`.as("description"),
      amount: chronoSession.amountCharged,
      status: chronoSession.status,
    })
    .from(chronoSession)
    .innerJoin(chronoStation, eq(chronoSession.stationId, chronoStation.id))
    .where(and(...conditions));
}

function reservationBranch(tx: TenantTx, { tenantId, memberId, q }: BranchArgs) {
  const conditions = [
    eq(chronoReservation.tenantId, tenantId),
    eq(chronoReservation.memberId, memberId),
  ];
  if (q) conditions.push(ilike(chronoStation.name, `%${q}%`));
  return tx
    .select({
      id: chronoReservation.id,
      type: sql<string>`'reservation'`.as("type"),
      occurredAt: chronoReservation.createdAt,
      title: sql<string>`'Reservation at ' || ${chronoStation.name}`.as("title"),
      description: sql<string>`case ${chronoReservation.status}
        when 'confirmed' then 'Upcoming reservation'
        when 'checked_in' then 'Checked in'
        when 'completed' then 'Completed'
        when 'cancelled' then 'Cancelled'
        when 'cancelled_late' then 'Cancelled (late fee applied)'
        when 'no_show' then 'No-show'
        when 'pending' then 'Waiting in queue'
        when 'hold' then 'Claim window active'
        when 'queue_expired' then 'Queue hold expired'
        else ${chronoReservation.status}
      end`.as("description"),
      amount: chronoReservation.cancelledLateFeeAmount,
      status: chronoReservation.status,
    })
    .from(chronoReservation)
    .innerJoin(chronoStation, eq(chronoReservation.stationId, chronoStation.id))
    .where(and(...conditions));
}

const BRANCH_BUILDERS = {
  wallet: walletBranch,
  credit: creditBranch,
  session: sessionBranch,
  reservation: reservationBranch,
} as const;

export function activityPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/", zValidator("query", activityListQuerySchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { page, pageSize, sort, order, type, q } = c.req.valid("query");
      const args: BranchArgs = { tenantId, memberId, q };

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        // A `type` filter picks a single branch directly — cheaper and
        // simpler than unioning all four and filtering the merged result.
        const combined = (
          type ? BRANCH_BUILDERS[type as ActivityEventType](tx, args) : unionAll(
            walletBranch(tx, args),
            creditBranch(tx, args),
            sessionBranch(tx, args),
            reservationBranch(tx, args),
          )
        ).as("activity");

        const [total] = await tx.select({ value: count() }).from(combined);
        const orderFn = order === "asc" ? asc : desc;
        const rows = await tx
          .select()
          .from(combined)
          .orderBy(orderFn(combined.occurredAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });

      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          type: row.type as ActivityEventType,
          occurredAt: row.occurredAt.toISOString(),
          title: row.title,
          description: row.description,
          amount: row.amount,
          status: row.status,
        })),
        meta: buildPaginationMeta(page, pageSize, totalItems, sort ?? "occurredAt", order ?? "desc"),
      });
    });
}
