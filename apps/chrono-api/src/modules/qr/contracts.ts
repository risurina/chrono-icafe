import { z } from "zod";
import { chronoStationStatusSchema } from "../realtime/contracts";

/**
 * Short TTL — the token rotates fast, unlike oikos's bare 5-minute window.
 * See qr plan Pass 2, "Token design".
 */
export const QR_TOKEN_TTL_SECONDS = 60;

/**
 * `qr-{stationId}-{version}-{timestamp}-{nonce}:{signature}` — matches the
 * token format in `token.ts`. Validated before any parsing so a malformed or
 * oversized value is rejected uniformly (qr plan Pass 2, Divergence 7).
 */
export const QR_TOKEN_RE = /^qr-[A-Za-z0-9]+-\d+-\d+-[a-f0-9]+:[a-f0-9]{64}$/;

export const qrTokenSchema = z.string().regex(QR_TOKEN_RE, "Invalid QR code format");

/** `GET /public/qr/resolve` request. */
export const resolveQrSchema = z.object({
  token: qrTokenSchema,
});
export type ResolveQrInput = z.infer<typeof resolveQrSchema>;

/**
 * This station's live availability, resolved the same way `/public/stations`
 * normalises `ChronoStations.status` (`toPublicStationStatus`, reused, not
 * reimplemented) — never the raw admin-settable subset.
 */
export const qrStationAvailabilitySchema = z.object({
  status: chronoStationStatusSchema,
  branchAvailable: z.number().int().nonnegative(),
  branchTotal: z.number().int().nonnegative(),
});
export type QrStationAvailability = z.infer<typeof qrStationAvailabilitySchema>;

/** `GET /public/qr/resolve` response — never a raw DB row. */
export const qrResolveResultSchema = z.object({
  tenantSlug: z.string(),
  tenantHost: z.string(),
  stationId: z.string(),
  stationName: z.string(),
  branchName: z.string(),
  requiresLogin: z.boolean(),
  // Rate — decimal-as-string, matching `stationGroupDtoSchema.hourlyRate` /
  // `.memberRate` exactly (never a float). `null` when the station has no
  // station group assigned yet.
  hourlyRate: z.string().nullable(),
  memberRate: z.string().nullable(),
  availability: qrStationAvailabilitySchema,
});
export type QrResolveResult = z.infer<typeof qrResolveResultSchema>;

/** `POST /public/qr/consume` request. */
export const consumeQrSchema = z.object({
  token: qrTokenSchema,
});
export type ConsumeQrInput = z.infer<typeof consumeQrSchema>;

/**
 * `POST /public/qr/consume` response. `sessionId` is set only when a real
 * session was started (Phase 5) — never a raw `ChronoSessions` row.
 */
export const qrConsumeResultSchema = z.object({
  resolved: z.boolean(),
  sessionStartAvailable: z.boolean(),
  sessionId: z.string().optional(),
});
export type QrConsumeResult = z.infer<typeof qrConsumeResultSchema>;

/** `POST /rpc/stations/:id/qr/regenerate` request. */
export const regenerateStationQrSchema = z.object({
  stationId: z.string().min(1),
});
export type RegenerateStationQrInput = z.infer<typeof regenerateStationQrSchema>;

/**
 * `POST /rpc/stations/:id/qr/regenerate` response — the freshly minted token
 * plus its rendering URL, so staff can immediately re-print the sticker.
 */
export const stationQrStatusSchema = z.object({
  stationId: z.string(),
  qrSecretVersion: z.number().int().nonnegative(),
  token: z.string(),
  qrUrl: z.string(),
  expiresAt: z.string(), // ISO string — contracts stay serializable over the wire.
});
export type StationQrStatus = z.infer<typeof stationQrStatusSchema>;
