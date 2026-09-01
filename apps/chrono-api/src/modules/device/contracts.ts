import { z } from "zod";
import { listQuerySchema } from "agora";

export const deviceStatusSchema = z.enum(["pending_approval", "approved", "revoked"]);

// ── Device-facing (no staff session) ──
export const pairDeviceSchema = z.object({
  pairingCode: z.string().min(1).max(32),
});

export const authDeviceSchema = z.object({
  fingerprint: z.string().min(1).max(512),
  hostname: z.string().max(255).optional(),
  provisioningToken: z.string().min(1),
});

export const heartbeatSchema = z.object({
  lockState: z.string().max(50).optional(),
  runtimeStatus: z.string().max(50).optional(),
  clientVersion: z.string().max(50).optional(),
  osVersion: z.string().max(100).optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
});

// ── Staff-facing ──
export const createProvisioningTokenSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(255),
  // Minutes until the human-facing pairing code expires. Short by design —
  // oikos used 60.
  pairingCodeTtlMinutes: z.number().int().positive().max(24 * 60).default(60),
  // Optional cap for golden-image reuse across many PCs; omitted = unbounded.
  maxUses: z.number().int().positive().max(1000).optional(),
});

export const approveDeviceSchema = z.object({
  // Assign to an existing station, or omit to create one from name/number.
  stationId: z.string().min(1).optional(),
  newStationName: z.string().min(1).max(255).optional(),
  newStationNumber: z.string().min(1).max(50).optional(),
});

export const relinkDeviceSchema = z.object({
  stationId: z.string().min(1),
});

export const deviceListQuerySchema = listQuerySchema([
  "hostname",
  "createdAt",
  "lastSeenAt",
]).extend({
  branchId: z.string().optional(),
  status: deviceStatusSchema.optional(),
});

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export type PairDeviceInput = z.infer<typeof pairDeviceSchema>;
export type AuthDeviceInput = z.infer<typeof authDeviceSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type CreateProvisioningTokenInput = z.infer<typeof createProvisioningTokenSchema>;
export type ApproveDeviceInput = z.infer<typeof approveDeviceSchema>;
export type RelinkDeviceInput = z.infer<typeof relinkDeviceSchema>;
