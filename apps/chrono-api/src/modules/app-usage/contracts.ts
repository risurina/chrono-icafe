import { z } from "zod";
import { listQuerySchema } from "agora";

export const appUsageCategorySchema = z.enum(["app", "game"]);

// Device-ingest payload (Payload Contracts). Both startedAt/endedAt are
// always device-reported domain timestamps, never server-now() — see the
// module README's "Payload Contracts" for why this matters for backlog replay.
export const appUsageLaunchedEntrySchema = z.object({
  runId: z.string().min(1).max(128),
  category: appUsageCategorySchema,
  appName: z.string().min(1).max(255),
  executablePath: z.string().max(1024).optional(),
  startedAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const appUsageClosedEntrySchema = z.object({
  runId: z.string().min(1).max(128),
  endedAt: z.string().datetime(),
});

export const reportAppUsageEventsSchema = z.object({
  launched: z.array(appUsageLaunchedEntrySchema).max(50),
  closed: z.array(appUsageClosedEntrySchema).max(50),
});

export const appUsageCurrentQuerySchema = z.object({
  stationId: z.string().min(1),
});

export const appUsageListQuerySchema = listQuerySchema(["startedAt", "appName"]).extend({
  branchId: z.string().optional(),
  stationId: z.string().optional(),
  category: appUsageCategorySchema.optional(),
  appName: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const appUsageSummaryQuerySchema = listQuerySchema(["totalDuration", "appName"]).extend({
  branchId: z.string().optional(),
  category: appUsageCategorySchema.optional(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export type AppUsageCategory = z.infer<typeof appUsageCategorySchema>;
export type AppUsageLaunchedEntry = z.infer<typeof appUsageLaunchedEntrySchema>;
export type AppUsageClosedEntry = z.infer<typeof appUsageClosedEntrySchema>;
export type ReportAppUsageEventsInput = z.infer<typeof reportAppUsageEventsSchema>;
export type AppUsageCurrentQuery = z.infer<typeof appUsageCurrentQuerySchema>;
export type AppUsageListQuery = z.infer<typeof appUsageListQuerySchema>;
export type AppUsageSummaryQuery = z.infer<typeof appUsageSummaryQuerySchema>;
