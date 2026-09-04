import { z } from 'zod';
import { listQuerySchema } from 'agora';

export const sessionStatusSchema = z.enum(['active', 'paused', 'ended']);

export const startSessionSchema = z.object({
  stationId: z.string().min(1),
  memberId: z.string().min(1),
  durationMinutes: z.number().int().positive().max(1440).optional(),
});

export const extendSessionSchema = z.object({
  minutes: z.number().int().positive().max(1440),
});

export const sessionListQuerySchema = listQuerySchema(['startedAt', 'createdAt']).extend({
  branchId: z.string().optional(),
  stationId: z.string().optional(),
  memberId: z.string().optional(),
  status: sessionStatusSchema.optional(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type ExtendSessionInput = z.infer<typeof extendSessionSchema>;

// --- Member portal DTOs (Phase B) ---------------------------------------

export const portalSessionListQuerySchema = listQuerySchema(['startedAt', 'createdAt']);

export const portalSessionSummarySchema = z.object({
  id: z.string(),
  stationId: z.string(),
  stationName: z.string(),
  status: sessionStatusSchema,
  startedAt: z.string(),
  scheduledEndAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  actualBillableSeconds: z.number().int().nullable(),
  amountCharged: z.string().nullable(),
  currency: z.string(),
});

export const portalSessionDetailSchema = portalSessionSummarySchema.extend({
  rateSnapshot: z.string(),
  creditMinutesConsumed: z.number().int(),
});

export const portalTodayUsageSchema = z.object({
  billableSeconds: z.number().int(),
  sessionCount: z.number().int(),
  amountCharged: z.string(),
  currency: z.string(),
  timezone: z.string(),
});

export type PortalSessionSummary = z.infer<typeof portalSessionSummarySchema>;
export type PortalSessionDetail = z.infer<typeof portalSessionDetailSchema>;
export type PortalTodayUsage = z.infer<typeof portalTodayUsageSchema>;
