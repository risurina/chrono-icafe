import { z } from "zod";
import { listQuerySchema } from "agora";

export const securityAlertSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

// Starter taxonomy (Divergence 5) — "other" is the escape hatch for anything
// not yet named; the DB column stays free text so a new named type never
// needs a migration, only a contract update.
export const securityAlertTypeSchema = z.enum([
  "device_tamper",
  "unauthorized_access",
  "unexpected_shutdown",
  "chassis_open",
  "camera_flagged",
  "customer_dispute",
  "theft_suspected",
  "other",
]);

export const securityAlertStatusSchema = z.enum(["open", "acknowledged", "resolved"]);

export const reportSecurityAlertSchema = z.object({
  branchId: z.string().min(1),
  stationId: z.string().min(1).optional(),
  severity: securityAlertSeveritySchema,
  type: securityAlertTypeSchema,
  message: z.string().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Device-facing report payload (Phase 5) — deliberately narrower than the
// staff schema: branchId/stationId are never taken from the client, only
// derived server-side from the authenticated device's own row.
export const deviceReportSecurityAlertSchema = z.object({
  severity: securityAlertSeveritySchema,
  type: securityAlertTypeSchema,
  message: z.string().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const resolveSecurityAlertSchema = z.object({
  resolutionNote: z.string().min(1).max(2000), // required — Divergence 2
});

export const securityAlertListQuerySchema = listQuerySchema([
  "createdAt",
  "severity",
]).extend({
  branchId: z.string().optional(),
  status: securityAlertStatusSchema.optional(),
  severity: securityAlertSeveritySchema.optional(),
});

export type SecurityAlertSeverity = z.infer<typeof securityAlertSeveritySchema>;
export type SecurityAlertType = z.infer<typeof securityAlertTypeSchema>;
export type SecurityAlertStatus = z.infer<typeof securityAlertStatusSchema>;
export type ReportSecurityAlertInput = z.infer<typeof reportSecurityAlertSchema>;
export type DeviceReportSecurityAlertInput = z.infer<typeof deviceReportSecurityAlertSchema>;
export type ResolveSecurityAlertInput = z.infer<typeof resolveSecurityAlertSchema>;
export type SecurityAlertListQuery = z.infer<typeof securityAlertListQuerySchema>;
