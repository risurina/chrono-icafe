import { z } from "zod";
import { listQuerySchema } from "agora";

export const reservationStatusSchema = z.enum([
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
  // Added by the reservations-queue-and-self-service plan:
  "pending", // a queue entry (fromQueue: true), no scheduled window yet
  "hold", // an activated direct reservation or a promoted queue entry — station-locking
  "cancelled_late", // cancelled inside the late-cancellation window (fee + ban)
  "queue_expired", // a queue hold lapsed unclaimed (failure record + possible ban)
]);

// Default cap resolved for Open Question 2: a reservation window may not
// exceed 12 hours (guards against a fat-fingered multi-day booking). Reused
// by the member-facing schemas below as the ceiling for both a direct
// reservation's duration and a queue join's requested duration.
const MAX_WINDOW_HOURS = 12;
export const durationMinutesSchema = z.number().int().min(15).max(MAX_WINDOW_HOURS * 60);

export const createReservationSchema = z
  .object({
    branchId: z.string().min(1),
    stationId: z.string().min(1),
    memberId: z.string().min(1).optional(), // omit for a phone/name-only booking
    customerName: z.string().max(255).optional(),
    customerPhone: z.string().max(50).optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), {
    message: "endAt must be after startAt",
    path: ["endAt"],
  })
  .refine(
    (v) =>
      new Date(v.endAt).getTime() - new Date(v.startAt).getTime() <=
      MAX_WINDOW_HOURS * 60 * 60 * 1000,
    { message: `A reservation cannot exceed ${MAX_WINDOW_HOURS} hours.`, path: ["endAt"] },
  )
  .refine((v) => v.memberId || v.customerName, {
    message: "Either memberId or customerName is required.",
    path: ["customerName"],
  });

export const updateReservationSchema = z
  .object({
    stationId: z.string().min(1).optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => !(v.startAt && v.endAt) || new Date(v.endAt) > new Date(v.startAt), {
    message: "endAt must be after startAt",
    path: ["endAt"],
  });

export const cancelReservationSchema = z.object({
  reason: z.string().max(255).optional(),
});

export const reservationListQuerySchema = listQuerySchema([
  "startAt",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
  stationId: z.string().optional(),
  status: reservationStatusSchema.optional(),
  memberId: z.string().optional(),
  // Board view: filter to reservations overlapping a given day/range.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// --- Member-portal contracts (reservations-queue-and-self-service plan) ---

/** Flow 1 — direct reservation on an available station. Member-facing subset:
 * no memberId param (taken from the member session), no customerName/Phone
 * (the member's own profile is used). */
export const createDirectReservationSchema = z.object({
  stationId: z.string().min(1),
  startAt: z.string().datetime(),
  durationMinutes: durationMinutesSchema,
});

/** Flow 2 — join the queue for a busy/reserved station. `durationMinutes` is
 * captured now (not derivable later — a queue entry has no startAt until
 * promoted) so promotion has a window to compute endAt from. */
export const joinQueueSchema = z.object({
  stationId: z.string().min(1),
  durationMinutes: durationMinutesSchema,
});

export const reservationPolicySchema = z.object({
  enabled: z.boolean(),
  reservationAdvanceWindowMinutes: z.number().int().min(1),
  maxActiveReservationsPerMember: z.number().int().min(1),
  lateCancellationWindowMinutes: z.number().int().min(0),
  cancellationFeeEnabled: z.boolean(),
  cancellationFeeAmount: z.number().min(0),
  reservationBanDurationHours: z.number().int().min(0),
  noShowBanDurationHours: z.number().int().min(0),
  holdPeriodMinutes: z.number().int().min(1),
  queueFailureLimit: z.number().int().min(1),
  queueBanDurationHours: z.number().int().min(0),
  allowQueueForReservedPc: z.boolean(),
  allowQueueForInUsePc: z.boolean(),
});

export const updateReservationPolicySchema = reservationPolicySchema.strict();

export const restrictionTypeSchema = z.enum(["reservation_ban", "queue_ban", "queue_failure"]);
export const restrictionReasonSchema = z.enum([
  "queue_hold_expired",
  "late_cancellation",
  "no_show",
  "scheduled_time_cancellation",
  "admin_manual",
  "queue_failure_limit",
]);

/** Member-facing restriction DTO — allowlisted, never metadataJson/liftedAt/
 * liftedByUserId (staff-only detail, per "do not expose unnecessary internal
 * penalty information"). */
export const memberRestrictionDtoSchema = z.object({
  type: restrictionTypeSchema,
  reason: restrictionReasonSchema,
  expiresAt: z.string().datetime().nullable(),
});

/**
 * Phase 4 (member-portal-v2) — discrete start-time slot picker. `date` is the
 * member's own local calendar date (YYYY-MM-DD, no timezone) for the
 * requested station's branch; `durationMinutes` defaults to 60 and must match
 * `createDirectReservationSchema`'s own bounds so a slot the picker marks
 * `available` is guaranteed bookable at that exact duration (mirrored, not
 * imported, from `service.ts`'s own advance-window/overlap checks — see
 * `service.ts`'s `createDirectReservation`).
 */
export const reservationAvailabilityQuerySchema = z.object({
  stationId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  durationMinutes: z.coerce.number().int().min(15).max(MAX_WINDOW_HOURS * 60).default(60),
});

export const reservationAvailabilitySlotSchema = z.object({
  startAt: z.string().datetime(),
  available: z.boolean(),
});

export const reservationAvailabilityResponseSchema = z.object({
  date: z.string(),
  stationId: z.string(),
  durationMinutes: z.number().int(),
  granularityMinutes: z.number().int(),
  slots: z.array(reservationAvailabilitySlotSchema),
});

export type ReservationAvailabilityQuery = z.infer<typeof reservationAvailabilityQuerySchema>;
export type ReservationAvailabilitySlot = z.infer<typeof reservationAvailabilitySlotSchema>;
export type ReservationAvailabilityResponse = z.infer<typeof reservationAvailabilityResponseSchema>;

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;
export type CreateDirectReservationInput = z.infer<typeof createDirectReservationSchema>;
export type JoinQueueInput = z.infer<typeof joinQueueSchema>;
export type ReservationPolicyInput = z.infer<typeof reservationPolicySchema>;
export type RestrictionType = z.infer<typeof restrictionTypeSchema>;
export type RestrictionReason = z.infer<typeof restrictionReasonSchema>;
