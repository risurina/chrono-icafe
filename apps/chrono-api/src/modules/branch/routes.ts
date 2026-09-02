import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count, ilike } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId, listQuerySchema } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../../db/schema";
import { createBranchSchema, updateBranchSchema, toBranchDto } from "./contracts";

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && err.code === "23505"
  );
}

/** "Main Branch #1" -> "main-branch-1"; collapses/trims non-alnum runs to a single dash. */
function generateBranchCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    endItem: Math.min(page * pageSize, totalItems),
    sort,
    order,
  };
}

export function branchRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted (matching domainRoutes()/
    // apiKeyRoutes()/brandingRoutes(), not a fresh tenantMiddleware chain).

    // GET is ungated — any tenant member can list (staff need read access for
    // future station/session branch context), matching the `project` pattern.
    .get(
      "/branches",
      zValidator("query", listQuerySchema(["name", "code", "createdAt"])),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order } = c.req.valid("query");
        const where = q ? ilike(chronoBranch.name, `%${q}%`) : undefined;
        const sortCol =
          sort === "name" ? chronoBranch.name : sort === "code" ? chronoBranch.code : chronoBranch.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoBranch)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoBranch)
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows.map(toBranchDto),
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post("/branches", zValidator("json", createBranchSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { branch: ["create"] });
      const input = c.req.valid("json");
      const code = input.code?.trim() || generateBranchCode(input.name);

      let created;
      try {
        [created] = await withTenant(tenantId, (tx) =>
          tx
            .insert(chronoBranch)
            .values({
              id: createId(),
              tenantId,
              name: input.name,
              code,
              status: input.status,
              address: input.address,
              contactNumber: input.contactNumber,
              email: input.email,
              operatingHours: input.operatingHours,
              timezone: input.timezone,
              latitude: input.latitude,
              longitude: input.longitude,
              googleMapsUrl: input.googleMapsUrl,
              socialLinks: input.socialLinks ?? null,
            })
            .returning(),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A branch with that code already exists.");
        }
        throw err;
      }

      await recordStaffAudit(c, {
        action: "branch.created",
        targetType: "branch",
        targetId: created?.id,
        targetLabel: created?.name,
      });
      return c.json({ branch: created ? toBranchDto(created) : null }, 201);
    })

    .patch("/branches/:id", zValidator("json", updateBranchSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { branch: ["update"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      let updated;
      try {
        [updated] = await withTenant(tenantId, (tx) =>
          tx
            .update(chronoBranch)
            .set({
              ...(input.name !== undefined && { name: input.name }),
              ...(input.code !== undefined && { code: input.code }),
              ...(input.status !== undefined && { status: input.status }),
              ...(input.address !== undefined && { address: input.address }),
              ...(input.contactNumber !== undefined && { contactNumber: input.contactNumber }),
              ...(input.email !== undefined && { email: input.email }),
              ...(input.operatingHours !== undefined && { operatingHours: input.operatingHours }),
              ...(input.timezone !== undefined && { timezone: input.timezone }),
              ...(input.latitude !== undefined && { latitude: input.latitude }),
              ...(input.longitude !== undefined && { longitude: input.longitude }),
              ...(input.googleMapsUrl !== undefined && { googleMapsUrl: input.googleMapsUrl }),
              ...(input.socialLinks !== undefined && { socialLinks: input.socialLinks }),
              updatedAt: new Date(),
            })
            .where(and(eq(chronoBranch.id, id), eq(chronoBranch.tenantId, tenantId)))
            .returning(),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A branch with that code already exists.");
        }
        throw err;
      }

      if (!updated) {
        throw new HttpError(404, "Branch not found.");
      }

      await recordStaffAudit(c, {
        action: "branch.updated",
        targetType: "branch",
        targetId: updated.id,
        targetLabel: updated.name,
      });
      return c.json({ branch: toBranchDto(updated) });
    });
}
