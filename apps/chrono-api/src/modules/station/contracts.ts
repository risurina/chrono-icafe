import { z } from "zod";
import { listQuerySchema } from "agora";
import { chronoStationStatusSchema } from "../realtime/contracts";

export const stationStatusSchema = z.enum(["available", "maintenance", "offline"]);

const stationSpecsSchema = z
  .object({
    cpu: z.string().max(255).nullable().optional(),
    gpu: z.string().max(255).nullable().optional(),
    ram: z.string().max(255).nullable().optional(),
    monitorHz: z.number().int().positive().max(1000).nullable().optional(),
  })
  .optional();

export const createStationGroupSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  hourlyRate: z.coerce.number().nonnegative().max(999999),
  memberRate: z.coerce.number().nonnegative().max(999999).optional(),
});
export const updateStationGroupSchema = createStationGroupSchema
  .omit({ branchId: true })
  .partial();

export const createStationSchema = z.object({
  branchId: z.string().min(1),
  stationGroupId: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  stationNumber: z.string().min(1).max(50),
  stationType: z.string().min(1).max(50).optional(),
  status: stationStatusSchema.optional(),
  locationZone: z.string().max(255).optional(),
  specs: stationSpecsSchema,
});
export const updateStationSchema = createStationSchema.omit({ branchId: true }).partial();

export const stationListQuerySchema = listQuerySchema([
  "name",
  "stationNumber",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
  stationGroupId: z.string().optional(),
});

export const stationGroupListQuerySchema = listQuerySchema([
  "name",
  "code",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
});

export type CreateStationGroupInput = z.infer<typeof createStationGroupSchema>;
export type UpdateStationGroupInput = z.infer<typeof updateStationGroupSchema>;
export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
export type StationStatus = z.infer<typeof stationStatusSchema>;

// Response DTOs — deliberately OMIT `qrSecret`/`qrSecretVersion` (the `qr`
// module's HMAC signing material). Never widen these to a raw row shape.
export const stationGroupDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  branchId: z.string(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  hourlyRate: z.string(),
  memberRate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const stationDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  branchId: z.string(),
  stationGroupId: z.string().nullable(),
  name: z.string(),
  stationNumber: z.string(),
  stationType: z.string(),
  status: stationStatusSchema,
  locationZone: z.string().nullable(),
  specs: stationSpecsSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StationGroupDto = z.infer<typeof stationGroupDtoSchema>;
export type StationDto = z.infer<typeof stationDtoSchema>;

// Public (unauthenticated) station-availability view — grouped by branch.
// Deliberately narrow: no `tenantId`/`stationGroupId`/`locationZone`/`specs`, nothing an
// anonymous visitor doesn't need to see (`.ai/rules/dto.md`).
// Buckets reconcile: total === available + inUse + unavailable.
//
// `inUse` means what its name (and the web's own "In session" label) says:
// stations with an active session, i.e. `status === "occupied"`. It used to be
// computed as maintenance+offline, which advertised a machine under
// maintenance as "in session" and counted genuinely-occupied ones nowhere.
// `occupied` is the unambiguous alias new callers should prefer; `inUse` is
// kept so existing consumers keep compiling.
export const publicStationAggregateSchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  inUse: z.number().int().nonnegative(),
  occupied: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
});

export const publicStationSchema = z.object({
  id: z.string(),
  name: z.string(),
  stationNumber: z.string(),
  stationType: z.string(),
  // The FULL four-value vocabulary, not the admin-settable subset
  // (`stationStatusSchema`). Sessions write "occupied" today
  // (session/service.ts), so a three-value schema here rejected the payload of
  // any venue with a station in use — and because the web re-validates and
  // falls back to null (chrono-web/src/lib/stations.ts), the whole live
  // availability surface blanked out exactly when the venue was busiest.
  status: chronoStationStatusSchema,
});

export const publicBranchStationsSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  aggregate: publicStationAggregateSchema,
  stations: z.array(publicStationSchema),
});

export const publicStationsResponseSchema = z.object({
  aggregate: publicStationAggregateSchema,
  branches: z.array(publicBranchStationsSchema),
});

export type PublicStationAggregate = z.infer<typeof publicStationAggregateSchema>;
export type PublicStation = z.infer<typeof publicStationSchema>;
export type PublicBranchStations = z.infer<typeof publicBranchStationsSchema>;
export type PublicStationsResponse = z.infer<typeof publicStationsResponseSchema>;

// Station Control board — one aggregate read merging station + group + the
// station's current active/paused session (if any). See
// `.ai/plans/chrono/active/station-control-grouping/README.md`, Phase 1.
// Deliberately unpaginated (bounded to one branch), mirroring
// `publicStationRoutes()`'s own "read everything for this branch" precedent.
export const stationBoardQuerySchema = z.object({
  branchId: z.string().min(1),
});

export const stationBoardSessionSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  memberName: z.string(),
  status: z.enum(["active", "paused"]),
  startedAt: z.string(),
  scheduledEndAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
});

export const stationBoardStationSchema = z.object({
  id: z.string(),
  stationNumber: z.string(),
  name: z.string(),
  stationType: z.string(),
  status: chronoStationStatusSchema,
  locationZone: z.string().nullable(),
  stationGroupId: z.string().nullable(),
  stationGroupName: z.string().nullable(),
  activeSession: stationBoardSessionSchema.nullable(),
});

export const stationBoardResponseSchema = z.object({
  branchId: z.string(),
  stations: z.array(stationBoardStationSchema),
});

export type StationBoardQuery = z.infer<typeof stationBoardQuerySchema>;
export type StationBoardSession = z.infer<typeof stationBoardSessionSchema>;
export type StationBoardStation = z.infer<typeof stationBoardStationSchema>;
export type StationBoardResponse = z.infer<typeof stationBoardResponseSchema>;

// "My Gaming Spots" venue-list live status (member-portal-v2 Phase 7) — one
// row per tenant a global customer belongs to. `available`/`total` reuse the
// exact bucket names `publicStationAggregateSchema` already established
// (Phase 3's `loadBranchAvailability`), narrowed here to the whole tenant's
// ACTIVE branches (mirroring `publicStationRoutes()`'s own active-branch
// filter) instead of one QR-scanned branch. `status` is a venue-level
// (not per-station) open/closed read: "open" when at least one station in an
// active branch is reachable (`available` or `occupied`, i.e. not
// `maintenance`/`offline`); "closed" otherwise (no active branch, or every
// station unreachable). There is no business-hours model yet, so this is the
// most honest signal available today — not a schedule-based open/closed.
export const membershipVenueStatusSchema = z.object({
  tenantSlug: z.string(),
  status: z.enum(["open", "closed"]),
  available: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const membershipVenueStatusResponseSchema = z.object({
  venues: z.array(membershipVenueStatusSchema),
});

export type MembershipVenueStatus = z.infer<typeof membershipVenueStatusSchema>;
export type MembershipVenueStatusResponse = z.infer<typeof membershipVenueStatusResponseSchema>;
