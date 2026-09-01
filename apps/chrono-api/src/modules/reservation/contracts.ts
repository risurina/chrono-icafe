import { z } from "zod";
import { listQuerySchema } from "agora";

export const reservationStatusSchema = z.enum([
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
]);

// Default cap resolved for Open Question 2: a reservation window may not
// exceed 12 hours (guards against a fat-fingered multi-day booking).
const MAX_WINDOW_HOURS = 12;

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

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;
