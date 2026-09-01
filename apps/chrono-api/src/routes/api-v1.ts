import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withTenant, ilike, and, isNull, count, asc, desc, eq } from "agora/db";
import { requirePermission } from "agora/auth";
import {
  tenantMiddleware,
  type TenantVars,
  zValidator,
  createRateLimiter,
  resolveStorage,
} from "agora/server";
import { createId, createProjectSchema, listQuerySchema, signUploadSchema, confirmUploadSchema } from "agora";
import { project, storedFile } from "../db/schema";
import { recordStaffAudit } from "agora/audit";
import { emitTenantEvent } from "agora/webhooks";
import { buildPaginationMeta, signFileForTenant, confirmFileForTenant } from "./rpc";

// 60 requests / minute per tenant (API keys are tenant-scoped, so keying by
// tenantId rate-limits every key a tenant has minted together — a deliberate
// per-tenant budget, not per-key).
const apiV1Limiter = createRateLimiter(60, 60 * 1000, "api-v1");

/**
 * Public versioned API (`/api/v1`) — a stable, API-key-authenticated surface
 * for third-party integrations, distinct from the internal `/rpc` client
 * contract (see `.ai/rules/api.md`'s "Versioning" section). Every handler
 * below delegates to the same permission-check + `withTenant` logic as the
 * equivalent `/rpc` route — this file adds only the envelope, never new
 * business logic. See `docs/api/v1.md` and
 * `.ai/plans/archive/generic-multitenant-extensibility/README.md` (Phase A).
 */
export const apiV1 = new Hono<{ Variables: TenantVars }>()
  .use("*", tenantMiddleware())
  .use("*", async (c, next) => {
    const { tenantId } = c.var.tenant;
    const retryAfter = await apiV1Limiter.blockedFor(tenantId);
    if (retryAfter !== null) {
      const requestId = randomUUID();
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests.", requestId } },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }
    await apiV1Limiter.record(tenantId);
    await next();
  })

  // ── Projects — same requirePermission/withTenant path as /rpc/projects ──
  .get(
    "/projects",
    zValidator("query", listQuerySchema(["name", "createdAt"])),
    async (c) => {
      const { tenantId } = c.var.tenant;
      const { page, pageSize, q, sort, order } = c.req.valid("query");
      const where = q ? ilike(project.name, `%${q}%`) : undefined;
      const sortCol = sort === "name" ? project.name : project.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(project).where(where);
        const items = await tx
          .select()
          .from(project)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows: items, totalItems: total?.value ?? 0 };
      });

      return c.json({
        data: { items: rows, meta: buildPaginationMeta(page, pageSize, totalItems, sort, order) },
        meta: { requestId: randomUUID(), apiVersion: "v1" as const },
      });
    },
  )
  .post("/projects", zValidator("json", createProjectSchema), async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { project: ["create"] });
    const { name } = c.req.valid("json");
    const [created] = await withTenant(tenantId, (tx) =>
      tx.insert(project).values({ id: createId(), tenantId, name }).returning(),
    );
    await recordStaffAudit(c, {
      action: "project.created",
      targetType: "project",
      targetId: created?.id,
      targetLabel: created?.name,
    });
    await emitTenantEvent(tenantId, "project.created", { id: created?.id, name: created?.name });
    return c.json(
      { data: created, meta: { requestId: randomUUID(), apiVersion: "v1" as const } },
      201,
    );
  })
  .delete("/projects/:id", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { project: ["delete"] });
    const id = c.req.param("id");
    const deleted = await withTenant(tenantId, (tx) =>
      tx.delete(project).where(eq(project.id, id)).returning(),
    );
    if (deleted.length === 0) {
      const requestId = randomUUID();
      return c.json(
        { error: { code: "not_found", message: "Project not found.", requestId } },
        404,
      );
    }
    await recordStaffAudit(c, {
      action: "project.deleted",
      targetType: "project",
      targetId: id,
      targetLabel: deleted[0]?.name,
    });
    await emitTenantEvent(tenantId, "project.deleted", { id, name: deleted[0]?.name });
    return c.json({
      data: { ok: true },
      meta: { requestId: randomUUID(), apiVersion: "v1" as const },
    });
  })

  // ── Files — same requirePermission/withTenant path as /rpc/files ──
  .get(
    "/files",
    zValidator("query", listQuerySchema(["originalName", "createdAt"])),
    async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { file: ["read"] });
      const { page, pageSize, q, sort, order } = c.req.valid("query");
      const where = and(
        isNull(storedFile.deletedAt),
        q ? ilike(storedFile.originalName, `%${q}%`) : undefined,
      );
      const sortCol = sort === "originalName" ? storedFile.originalName : storedFile.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(storedFile).where(where);
        const items = await tx
          .select()
          .from(storedFile)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows: items, totalItems: total?.value ?? 0 };
      });

      const storage = await resolveStorage(tenantId);
      const items = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          publicUrl:
            row.visibility === "public" ? await storage.publicUrl(row.storageKey) : undefined,
        })),
      );

      return c.json({
        data: { items, meta: buildPaginationMeta(page, pageSize, totalItems, sort, order) },
        meta: { requestId: randomUUID(), apiVersion: "v1" as const },
      });
    },
  )
  .post("/files/sign", zValidator("json", signUploadSchema), async (c) => {
    const { tenantId, userId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { file: ["create"] });
    const input = c.req.valid("json");
    const { ticket, fileId } = await signFileForTenant(tenantId, userId, input);
    await recordStaffAudit(c, {
      action: "file.upload_started",
      targetType: "file",
      targetId: fileId,
      targetLabel: input.originalName,
    });
    return c.json({
      data: { ticket, fileId },
      meta: { requestId: randomUUID(), apiVersion: "v1" as const },
    });
  })
  .post("/files/:id/confirm", zValidator("json", confirmUploadSchema), async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { file: ["create"] });
    const { id } = c.req.param();
    const input = c.req.valid("json");
    const { row, publicUrl } = await confirmFileForTenant(tenantId, id, input);
    await recordStaffAudit(c, {
      action: "file.uploaded",
      targetType: "file",
      targetId: id,
      targetLabel: row.originalName,
    });
    await emitTenantEvent(tenantId, "file.uploaded", row);
    return c.json({
      data: { ...row, publicUrl },
      meta: { requestId: randomUUID(), apiVersion: "v1" as const },
    });
  });

export type ApiV1Type = typeof apiV1;
