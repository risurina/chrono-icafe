import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count, ilike } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import {
  type TenantVars,
  HttpError,
  zValidator,
  resolveOrgFromRequest,
  createRateLimiter,
  clientIp,
} from "agora/server";
import { createId, listQuerySchema } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../../db/schema";
import { chronoStationGroup } from "../station/schema";
import {
  createBranchSchema,
  updateBranchSchema,
  toBranchDto,
  type PublicVenueInfoResponse,
} from "./contracts";

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

// IP rate limiter: same numbers and rationale as `publicStationsLimiter` — a
// marketing-page read, not a money-moving route.
const publicVenueInfoLimiter = createRateLimiter(20, 60 * 1000, "public-venue-info");

// 10s in-memory cache keyed by tenantId, mirroring `publicStationsCache`: this
// is server-rendered on every landing-page view and the payload (business info
// + published rates) changes rarely, so an uncached read costs a 2-query DB
// round trip per visitor.
const PUBLIC_VENUE_INFO_TTL_MS = 10_000;
const publicVenueInfoCache = new Map<
  string,
  { data: PublicVenueInfoResponse; at: number }
>();

/**
 * `GET /public/venue-info` — the tenant's own public site's business-info and
 * rates data. Unauthenticated, so it follows the `/public/*` convention in
 * `apps/chrono-api/AGENTS.md`: IP rate limit, tenant resolved server-side from
 * the host (never client input), terminal statuses refused, and an explicit
 * column allowlist rather than a raw row.
 *
 * Serves exactly one tenant, resolved from the host, so the read goes through
 * `withTenant` (RLS-enforced) — never `withAdmin`. MVP shows the tenant's FIRST
 * active branch only (oldest by `createdAt`), mirroring `getTenantLanding()`'s
 * own `branches[0]` precedent; a per-branch public page is future work.
 */
export function publicVenueInfoRoutes() {
  return new Hono()
    .use("*", async (c, next) => {
      const ip = clientIp(c) || "unknown";
      const retryAfter = await publicVenueInfoLimiter.blockedFor(ip);
      if (retryAfter !== null) {
        return c.json({ error: "Too many requests." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }
      await publicVenueInfoLimiter.record(ip);
      await next();
    })
    .get("/", async (c) => {
      const org = await resolveOrgFromRequest(c);
      if (!org) {
        throw new HttpError(404, "Tenant not found.");
      }

      // Never serve public data for a tenant in a terminal lifecycle status.
      const status = org.status;
      if (
        status === "suspended" ||
        status === "cancelled" ||
        status === "archived" ||
        status === "deleting"
      ) {
        throw new HttpError(404, "Tenant not found.");
      }

      const now = Date.now();
      const cached = publicVenueInfoCache.get(org.id);
      if (cached && now - cached.at < PUBLIC_VENUE_INFO_TTL_MS) {
        return c.json(cached.data);
      }

      const data = await withTenant(org.id, async (tx): Promise<PublicVenueInfoResponse> => {
        const [branch] = await tx
          .select({
            id: chronoBranch.id,
            name: chronoBranch.name,
            address: chronoBranch.address,
            googleMapsUrl: chronoBranch.googleMapsUrl,
            operatingHours: chronoBranch.operatingHours,
            contactNumber: chronoBranch.contactNumber,
            email: chronoBranch.email,
            socialLinks: chronoBranch.socialLinks,
          })
          .from(chronoBranch)
          .where(eq(chronoBranch.status, "active"))
          .orderBy(asc(chronoBranch.createdAt))
          .limit(1);

        // A tenant with no active branch yet is a normal 200 with empty data —
        // never a 404. A public page must not dead-end on an unfinished setup.
        if (!branch) {
          return { branch: null, rateGroups: [] };
        }

        const groups = await tx
          .select({
            id: chronoStationGroup.id,
            name: chronoStationGroup.name,
            hourlyRate: chronoStationGroup.hourlyRate,
            memberRate: chronoStationGroup.memberRate,
          })
          .from(chronoStationGroup)
          .where(eq(chronoStationGroup.branchId, branch.id))
          .orderBy(asc(chronoStationGroup.name));

        return {
          branch: {
            name: branch.name,
            address: branch.address,
            googleMapsUrl: branch.googleMapsUrl,
            operatingHours: branch.operatingHours,
            contactNumber: branch.contactNumber,
            email: branch.email,
            socialLinks: branch.socialLinks ?? null,
          },
          rateGroups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            hourlyRate: g.hourlyRate,
            memberRate: g.memberRate,
          })),
        };
      });

      publicVenueInfoCache.set(org.id, { data, at: now });

      return c.json(data);
    });
}
