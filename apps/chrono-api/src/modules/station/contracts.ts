import { z } from "zod";
import { listQuerySchema } from "agora";

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
