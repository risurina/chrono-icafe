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
