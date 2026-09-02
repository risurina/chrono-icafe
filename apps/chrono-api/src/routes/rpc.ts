import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import {
  createRealtimeRoute,
  type ResolveActor,
  type RealtimeLimits,
} from "agora/realtime";
import { validateChronoScopes } from "../modules/realtime/contracts";
import {
  withTenant,
  adminDb,
  schema as base,
  eq,
  and,
  or,
  desc,
  asc,
  gte,
  lte,
  count,
  ilike,
  isNull,
  sql,
} from "agora/db";
import { requirePermission, assertCanAssignRole, assertOutranks } from "agora/auth";
import { hashMemberPassword, revokeMemberSessions } from "agora/member-auth";
import {
  tenantMiddleware,
  type TenantVars,
  HttpError,
  renderBrandedEmail,
  assertPublicHttpsUrl,
  encryptSecret,
  hasEncryptionKey,
  zValidator,
} from "agora/server";
import { usageMeteringMiddleware } from "agora/server";
import {
  createId,
  createProjectSchema,
  listAuditQuerySchema,
  listQuerySchema,
  listNotificationFeedQuerySchema,
  type PaginationMeta,
  updateMemberRoleSchema,
  createCustomerSchema,
  updateCustomerSchema,
  upsertEmailIntegrationSchema,
  upsertStorageIntegrationSchema,
  type AuditEvent,
  type Customer,
  type EmailIntegration,
  type StorageIntegration,
  type Role,
  type ActiveAnnouncement,
  type AnnouncementTargeting,
} from "agora";
import {
  project,
  auditEvent,
  tenantBranding,
  tenantSecurityPolicy,
  tenantIntegration,
  storedFile,
  tenantNotification,
} from "../db/schema";
import { recordStaffAudit } from "agora/audit";
import { branchRoutes } from "../modules/branch/routes";
import { stationRoutes, publicStationRoutes } from "../modules/station/routes";
import { reservationRoutes } from "../modules/reservation/routes";
import { shiftRoutes } from "../modules/shift/routes";
import { onboardingRoutes } from "../modules/onboarding/routes";
import { reconciliationRoutes } from "../modules/reconciliation/routes";
import { walletRoutes } from "../modules/wallet/routes";
import { paymentRoutes } from "../modules/payment/routes";
import { creditRoutes } from "../modules/credit/routes";
import { posRoutes } from "../modules/pos/routes";
import { sessionRoutes } from "../modules/session/routes";
import { reportRoutes } from "../modules/report/routes";
import { securityAlertRoutes } from "../modules/security-alert/routes";
import { inquiryRoutes } from "../modules/inquiry/routes";
import { landingPageRoutes } from "../modules/landing-page/routes";
import { loyaltyRoutes } from "../modules/loyalty/routes";
import { voucherRoutes } from "../modules/voucher/routes";
import { promoRoutes } from "../modules/promo/routes";
import { staffDeviceRoutes } from "../modules/device/routes";
import { stationQrRoutes } from "../modules/qr/routes";
import { CHRONO_FEATURE_FLAGS, CHRONO_MODULES } from "../contracts/extensions";
import { emitTenantEvent, webhookRoutes } from "agora/webhooks";
import { inviteRoutes } from "agora/invites";
import { domainRoutes } from "agora/domains";
import {
  brandingRoutes,
  featureFlagRoutes,
  apiKeyRoutes,
  securityRoutes,
  mfaEnforcement,
  isMfaEnrolled,
  roleRoutes,
  moduleRoutes,
} from "agora/server/routes";
import { billingRoutes } from "agora/billing/routes";
import { resolveEmailSender, resolveStorage } from "agora/server";
import { createTenantLifecycle } from "agora/tenant-lifecycle";
import { tenantLifecycleRoutes } from "agora/tenant-lifecycle/routes";
import * as appSchema from "../db/schema";
import { APP_TENANT_TABLES, tenantSubscription, announcementDelivery } from "../db/schema";
import { matchesTargeting } from "agora/server";
import {
  announcementParamsSchema,
  signUploadSchema,
  confirmUploadSchema,
  type SignUploadInput,
  type ConfirmUploadInput,
} from "agora/contracts";
import { memberProfileRoutes } from "../modules/member/routes";

// The app owns its table list, so it binds the foundation lifecycle ops to it.
// Exported so app.ts can reuse this exact instance when wiring the
// platform-admin compliance-export route — never construct a second one.
export const lifecycle = createTenantLifecycle({
  schema: appSchema,
  tenantTables: APP_TENANT_TABLES,
});
const { exportMember, deleteMember } = lifecycle;

/**
 * The per-tenant path segment used to namespace upload keys — human-legible
 * (subdomain, or a verified custom domain) rather than the opaque
 * `tenantId`, so a tenant's files sit in a folder matching what they see in
 * their browser bar. Preference order: verified primary custom domain (the
 * tenant's own hostname) → org slug (the tenant subdomain, always present) →
 * tenantId as a last-resort fallback should the org row ever be missing.
 * `domain` is RLS-forced (BASE_TENANT_TABLES) so it's read inside the same
 * `withTenant` transaction; `organization` is a foundation table filtered
 * explicitly by id via `adminDb`, same as every other `member`/`invitation`-
 * style lookup.
 */
async function resolveTenantPathSegment(tenantId: string): Promise<string> {
  const [primaryDomain] = await withTenant(tenantId, (tx) =>
    tx
      .select({ hostname: base.domain.hostname })
      .from(base.domain)
      .where(
        and(
          eq(base.domain.tenantId, tenantId),
          eq(base.domain.isPrimary, true),
          sql`${base.domain.verifiedAt} is not null`,
        ),
      )
      .limit(1),
  );
  if (primaryDomain?.hostname) {
    return primaryDomain.hostname;
  }

  const [org] = await adminDb
    .select({ slug: base.organization.slug })
    .from(base.organization)
    .where(eq(base.organization.id, tenantId))
    .limit(1);
  return org?.slug ?? tenantId;
}

async function resolveTenantUploadFolder(tenantId: string): Promise<string> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(tenantIntegration)
      .where(
        and(
          eq(tenantIntegration.tenantId, tenantId),
          eq(tenantIntegration.category, "storage"),
        ),
      )
      .limit(1),
  );
  const folder = (row?.config as any)?.folder;
  if (folder && typeof folder === "string" && folder.trim() !== "") {
    return folder.trim();
  }
  // No per-tenant folder configured: fall back to the platform-wide base
  // folder (STORAGE_FOLDER), driver-agnostic and applied to every provider
  // since it's baked into the key itself, not a provider-specific setting.
  // Unset → root (no prefix beyond the per-tenant scoping below).
  const base_ = process.env.STORAGE_FOLDER?.trim();
  const tenantSegment = await resolveTenantPathSegment(tenantId);
  return base_ ? `${base_}/${tenantSegment}` : tenantSegment;
}

/**
 * Shared sign-upload mechanics for a specific tenant, used by both the
 * tenant-scoped `/rpc/files/sign` route (session actor) and the
 * platform-admin org-detail upload route (`agora/platform-admin`'s
 * `appFilesRoutes`, injected via `SignFileForOrgFn`) — one place owns the
 * key-building + storage-ticket + `storedFile` insert so the two call sites
 * can never drift. Callers still do their own permission gate and audit
 * write, since those differ (tenant `requirePermission`/`recordStaffAudit`
 * vs platform `requirePlatformPermissionForRequest`/`recordPlatformAudit`).
 */
export async function signFileForTenant(
  tenantId: string,
  userId: string | null,
  input: SignUploadInput,
) {
  const fileId = createId();
  const folder = await resolveTenantUploadFolder(tenantId);
  // Cloudinary's `auto/upload` picks `resource_type` (image vs raw) from the
  // actual file content, but our own `publicUrl(key)` has to guess it back
  // from the key's extension since we don't get the upload response (the
  // client uploads directly to Cloudinary). Without an extension on the key,
  // that guess always lands on "raw", producing a broken link for images. So
  // the key must carry the original extension to keep both sides in sync.
  const extMatch = input.originalName.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  const name = `${fileId}${ext}`;
  // Layout: <tenant folder>/<public|private>/<feature>/<name> — the
  // visibility segment separates the two access models on disk/bucket, not
  // just in the `storedFile.visibility` column, so a bucket-level policy
  // (e.g. a public-read prefix) can key off the path alone.
  const key = input.feature
    ? `${folder}/${input.visibility}/${input.feature}/${name}`
    : `${folder}/${input.visibility}/${name}`;

  const storage = await resolveStorage(tenantId);
  const ticket = await storage.signUpload({ ...input, key, maxBytes: input.sizeBytes });

  await withTenant(tenantId, (tx) =>
    tx.insert(storedFile).values({
      id: fileId,
      tenantId,
      provider: storage.provider,
      storageKey: key,
      visibility: input.visibility,
      feature: input.feature ?? null,
      originalName: input.originalName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: "pending",
      uploadedBy: userId,
    }),
  );

  return { ticket, fileId };
}

/** Shared confirm-upload mechanics — see {@link signFileForTenant}. */
export async function confirmFileForTenant(
  tenantId: string,
  fileId: string,
  _input: ConfirmUploadInput,
) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .update(storedFile)
      .set({ status: "ready" })
      .where(and(eq(storedFile.tenantId, tenantId), eq(storedFile.id, fileId)))
      .returning(),
  );

  if (!row) {
    throw new HttpError(404, "File not found.");
  }

  let publicUrl: string | undefined;
  if (row.visibility === "public") {
    const storage = await resolveStorage(tenantId);
    publicUrl = await storage.publicUrl(row.storageKey);
  }
  return { row, publicUrl };
}

/** Shared `{page, pageSize, ...}` → `PaginationMeta` builder for listQuerySchema routes. */
export function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
): PaginationMeta {
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

/** Build a tenant-host URL for Stripe redirect/return links. */
function tenantHostUrl(slug: string, path: string): string {
  const appDomain = process.env.APP_DOMAIN ?? "localtest.me:3000";
  const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
  return `${scheme}://${slug}.${appDomain}${path}`;
}

/**
 * Tenant-scoped RPC. `tenantMiddleware()` from the foundation populates
 * `c.var.tenant` (authorized). Tenant-scoped tables (project, domain) go
 * through withTenant so RLS is active; org tables (member, invitation) are
 * filtered explicitly by tenantId.
 */
export const rpc = new Hono<{ Variables: TenantVars }>()
  // ── Public unauthenticated routes (mounted BEFORE tenantMiddleware) ──
  .route("/public/stations", publicStationRoutes())

  .use("*", tenantMiddleware())

  // ── Usage metering (platform-usage-limits Phase 6) ──
  // Best-effort `api_requests` counter, fire-and-forget, behind
  // `USAGE_METERING_ENABLED` (off by default). Placed AFTER tenantMiddleware so
  // c.var.tenant exists; never awaited, so it adds no latency.
  .use("*", usageMeteringMiddleware())

  // ── MFA enforcement ──
  // When the tenant's policy sets `mfaRequired`, staff who haven't enrolled TOTP
  // are blocked from the rest of the tenant surface with a `mfa_required` marker
  // the web app uses to route to enrollment. `/me` and the whole `/security`
  // surface stay reachable so admins can manage policy and users can enroll —
  // otherwise a required-but-unenrolled admin would lock themselves out.
  .use("*", mfaEnforcement())

  // ── whoami: current tenant + role (+ MFA enforcement markers) ──
  .get("/me", async (c) => {
    const t = c.var.tenant;
    const [policy] = await withTenant(t.tenantId, (tx) =>
      tx
        .select({ mfaRequired: tenantSecurityPolicy.mfaRequired })
        .from(tenantSecurityPolicy)
        .where(eq(tenantSecurityPolicy.tenantId, t.tenantId))
        .limit(1),
    );
    const mfaRequired = policy?.mfaRequired ?? false;
    const mfaEnrolled = await isMfaEnrolled(t.userId);

    // Platform-wide, Agora-staff-authored announcements
    // (.ai/plans/agora/active/platform-announcements/README.md), folded into this
    // existing polled response rather than a second route + a second
    // poller. Read via adminDb — platformAnnouncement carries no tenant_id,
    // so there is nothing for withTenant/RLS to scope; this query does not
    // read c.var.tenant beyond tenantMiddleware() having already run for
    // this route (a valid tenant actor: member session or tenant API key).
    // No query params accepted for this data — nothing a client could
    // supply that could be mistaken for tenant scoping.
    const now = new Date();
    const activeAnnouncementRows = await adminDb
      .select({
        id: base.platformAnnouncement.id,
        message: base.platformAnnouncement.message,
        type: base.platformAnnouncement.type,
        targeting: base.platformAnnouncement.targeting,
        channels: base.platformAnnouncement.channels,
        severity: base.platformAnnouncement.severity,
        startsAt: base.platformAnnouncement.startsAt,
        endsAt: base.platformAnnouncement.endsAt,
      })
      .from(base.platformAnnouncement)
      .where(
        and(
          lte(base.platformAnnouncement.startsAt, now),
          or(
            isNull(base.platformAnnouncement.endsAt),
            gte(base.platformAnnouncement.endsAt, now),
          ),
        ),
      )
      // Critical-first, never a plain `ORDER BY severity` — that column is
      // text, and alphabetically "critical" < "info" < "warning", which
      // would rank info above warning.
      .orderBy(
        sql`case ${base.platformAnnouncement.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
        desc(base.platformAnnouncement.startsAt),
      );

    let plan: string | null = null;
    const usesPlanTargeting = activeAnnouncementRows.some(
      (r) => r.targeting && (r.targeting as any).mode === "plans"
    );
    if (usesPlanTargeting) {
      const [sub] = await withTenant(t.tenantId, (tx) =>
        tx
          .select({ plan: tenantSubscription.plan })
          .from(tenantSubscription)
          .where(eq(tenantSubscription.tenantId, t.tenantId))
          .limit(1)
      );
      if (sub) {
        plan = sub.plan;
      }
    }

    const filteredAnnouncements = activeAnnouncementRows.filter((r) =>
      Array.isArray(r.channels) && r.channels.includes("in_app") &&
      matchesTargeting(r.targeting as AnnouncementTargeting | null, {
        tenantId: t.tenantId,
        plan,
        role: t.role,
        userId: t.userId,
      })
    );

    const activeAnnouncements: ActiveAnnouncement[] = filteredAnnouncements.map((r) => ({
      id: r.id,
      message: r.message,
      type: r.type as ActiveAnnouncement["type"],
      severity: r.severity as ActiveAnnouncement["severity"],
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    }));

    return c.json({
      userId: t.userId,
      tenantId: t.tenantId,
      tenantSlug: t.tenantSlug,
      role: t.role,
      // Visibility only — every route enforces independently server-side.
      permissions: t.permissions,
      mfaRequired,
      mfaEnrolled,
      // Boolean only — the impersonating admin's internal user id has no
      // legitimate use on the impersonated tenant's own browser session.
      impersonating: t.impersonation !== null,
      activeAnnouncements,
    });
  })

  .post(
    "/announcements/:id/read",
    zValidator("param", announcementParamsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { tenantId, userId } = c.var.tenant;

      // A stale banner may post an id that was retired+deleted; treat a
      // missing row as a no-op rather than tripping the FK (500). The
      // receipt is always scoped to the caller's own userId/tenantId.
      const [exists] = await adminDb
        .select({ id: base.platformAnnouncement.id })
        .from(base.platformAnnouncement)
        .where(eq(base.platformAnnouncement.id, id))
        .limit(1);
      if (!exists) return c.json({ ok: true });

      await adminDb
        .insert(announcementDelivery)
        .values({
          id: createId(),
          announcementId: id,
          channel: "in_app",
          recipientUserId: userId,
          organizationId: tenantId,
          status: "delivered",
          readAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            announcementDelivery.announcementId,
            announcementDelivery.recipientUserId,
            announcementDelivery.channel,
          ],
          set: { readAt: new Date() },
        });

      return c.json({ ok: true });
    }
  )

  // ── White-label branding — foundation factory (agora/server/routes) ──
  .route("/", brandingRoutes())

  // ── Feature flags — foundation factory + Chrono's merged registry (apps/chrono-api/src/contracts/extensions.ts) ──
  .route("/", featureFlagRoutes(CHRONO_FEATURE_FLAGS))

  // ── Module registry — foundation factory + Chrono's merged registry (apps/chrono-api/src/contracts/extensions.ts) ──
  .route("/", moduleRoutes(CHRONO_MODULES))

  // ── Tenant-defined custom roles — foundation factory (agora/server/routes) ──
  .route("/", roleRoutes())

  // ── Audit log (admin+, paginated + filtered, RLS-protected) ──
  .get("/audit", zValidator("query", listAuditQuerySchema), async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { audit: ["read"] });
    const { page, pageSize, action, actorId, from, to } = c.req.valid("query");

    const conds = [];
    if (action) conds.push(eq(auditEvent.action, action));
    if (actorId) conds.push(eq(auditEvent.actorId, actorId));
    if (from) conds.push(gte(auditEvent.createdAt, new Date(from)));
    if (to) conds.push(lte(auditEvent.createdAt, new Date(to)));
    const where = conds.length ? and(...conds) : undefined;

    const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
      const [total] = await tx
        .select({ value: count() })
        .from(auditEvent)
        .where(where);
      const rows = await tx
        .select()
        .from(auditEvent)
        .where(where)
        .orderBy(desc(auditEvent.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { rows, totalItems: total?.value ?? 0 };
    });

    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const items: AuditEvent[] = rows.map((r) => ({
      id: r.id,
      actorType: r.actorType as AuditEvent["actorType"],
      actorId: r.actorId,
      actorLabel: r.actorLabel,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      metadata: (r.metadata as AuditEvent["metadata"]) ?? null,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    }));

    return c.json({
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
        startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
        endItem: Math.min(page * pageSize, totalItems),
      },
    });
  })

  // ── Projects (this app's example tenant-scoped CRUD, RLS-protected) ──
  // GET is ungated (any tenant member can list); pagination/search/sort only.
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
        const [total] = await tx
          .select({ value: count() })
          .from(project)
          .where(where);
        const rows = await tx
          .select()
          .from(project)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });

      return c.json({
        items: rows,
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    },
  )

  // ── Files ──
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

    return c.json({ ticket, fileId });
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

    return c.json({ ...row, publicUrl });
  })
  .get(
    "/files",
    zValidator("query", listQuerySchema(["originalName", "createdAt"])),
    async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { file: ["read"] });
      const { page, pageSize, q, sort, order } = c.req.valid("query");
      const where = and(
        isNull(storedFile.deletedAt),
        q ? ilike(storedFile.originalName, `%${q}%`) : undefined
      );
      const sortCol = sort === "originalName" ? storedFile.originalName : storedFile.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(storedFile)
          .where(where);
        const rows = await tx
          .select()
          .from(storedFile)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });
      
      const storage = await resolveStorage(tenantId);
      const items = await Promise.all(
        rows.map(async (row) => {
          let publicUrl = undefined;
          if (row.visibility === "public") {
             publicUrl = await storage.publicUrl(row.storageKey);
          }
          return { ...row, publicUrl };
        })
      );

      return c.json({
        items,
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    },
  )
  .get("/files/:id/download-url", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { file: ["read"] });
    const { id } = c.req.param();

    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(storedFile)
        .where(
          and(
            eq(storedFile.tenantId, tenantId),
            eq(storedFile.id, id),
            isNull(storedFile.deletedAt)
          ),
        )
        .limit(1),
    );

    if (!row) {
      throw new HttpError(404, "File not found.");
    }

    const storage = await resolveStorage(tenantId);
    const url = await storage.signedDownloadUrl(row.storageKey, { expiresInSeconds: 3600 });
    return c.json({ url });
  })
  .delete("/files/:id", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { file: ["delete"] });
    const { id } = c.req.param();

    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .update(storedFile)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(storedFile.tenantId, tenantId),
            eq(storedFile.id, id),
            isNull(storedFile.deletedAt)
          ),
        )
        .returning(),
    );

    if (!row) {
      throw new HttpError(404, "File not found.");
    }
    
    // Best-effort provider delete
    const storage = await resolveStorage(tenantId);
    try {
      await storage.delete(row.storageKey);
    } catch (e) {
      // ignore
      console.warn("Failed to delete file from provider:", e);
    }

    await recordStaffAudit(c, {
      action: "file.deleted",
      targetType: "file",
      targetId: id,
      targetLabel: row.originalName,
    });
    await emitTenantEvent(tenantId, "file.deleted", row);

    return c.json({ ok: true });
  })

  // ── Notification feed (dashboard bell) — always scoped to the caller's own
  // recipientUserId, never a client-supplied one; notificationFeed:read is the
  // only gate (system-generated rows, no user-composed "manage" action) ──
  .get(
    "/notification-feed",
    zValidator("query", listNotificationFeedQuerySchema),
    async (c) => {
      const { tenantId, userId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { notificationFeed: ["read"] });
      const { page, pageSize } = c.req.valid("query");
      const mine = eq(tenantNotification.recipientUserId, userId);

      const { rows, totalItems, unreadCount } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(tenantNotification)
          .where(mine);
        const [unread] = await tx
          .select({ value: count() })
          .from(tenantNotification)
          .where(and(mine, isNull(tenantNotification.readAt)));
        const rows = await tx
          .select()
          .from(tenantNotification)
          .where(mine)
          .orderBy(desc(tenantNotification.createdAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return {
          rows,
          totalItems: total?.value ?? 0,
          unreadCount: unread?.value ?? 0,
        };
      });

      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          href: row.href,
          actorName: row.actorName,
          readAt: row.readAt ? row.readAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
        })),
        meta: buildPaginationMeta(page, pageSize, totalItems),
        unreadCount,
      });
    },
  )
  .post("/notification-feed/:id/read", async (c) => {
    const { tenantId, userId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { notificationFeed: ["read"] });
    const { id } = c.req.param();

    // Idempotent: only set readAt when still null, but 404 (never leak
    // existence of another user's row) whenever the caller's own row can't be
    // found in either state.
    const [existing] = await withTenant(tenantId, (tx) =>
      tx
        .select({ id: tenantNotification.id })
        .from(tenantNotification)
        .where(
          and(
            eq(tenantNotification.tenantId, tenantId),
            eq(tenantNotification.id, id),
            eq(tenantNotification.recipientUserId, userId),
          ),
        )
        .limit(1),
    );
    if (!existing) {
      throw new HttpError(404, "Notification not found.");
    }

    await withTenant(tenantId, (tx) =>
      tx
        .update(tenantNotification)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(tenantNotification.tenantId, tenantId),
            eq(tenantNotification.id, id),
            eq(tenantNotification.recipientUserId, userId),
            isNull(tenantNotification.readAt),
          ),
        ),
    );

    return c.json({ ok: true });
  })
  .post("/notification-feed/mark-all-read", async (c) => {
    const { tenantId, userId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { notificationFeed: ["read"] });

    await withTenant(tenantId, (tx) =>
      tx
        .update(tenantNotification)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(tenantNotification.tenantId, tenantId),
            eq(tenantNotification.recipientUserId, userId),
            isNull(tenantNotification.readAt),
          ),
        ),
    );

    return c.json({ ok: true });
  })
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
    await emitTenantEvent(tenantId, "project.created", {
      id: created?.id,
      name: created?.name,
    });
    return c.json({ project: created }, 201);
  })
  .delete("/projects/:id", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { project: ["delete"] });
    const id = c.req.param("id");
    const deleted = await withTenant(tenantId, (tx) =>
      tx.delete(project).where(eq(project.id, id)).returning(),
    );
    if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
    await recordStaffAudit(c, {
      action: "project.deleted",
      targetType: "project",
      targetId: id,
      targetLabel: deleted[0]?.name,
    });
    await emitTenantEvent(tenantId, "project.deleted", {
      id,
      name: deleted[0]?.name,
    });
    return c.json({ ok: true });
  })

  // ── Members (foundation table; filter by tenantId explicitly) ──
  // GET is ungated (any tenant member can list); pagination/search/sort only.
  .get(
    "/members",
    zValidator("query", listQuerySchema(["name", "email", "createdAt"])),
    async (c) => {
      const { tenantId } = c.var.tenant;
      const { page, pageSize, q, sort, order } = c.req.valid("query");
      // Built once and reused for both the count and row query (same join, same
      // where) — the org-tenant filter must never be dropped or rebuilt, since
      // `member` is a foundation table, not RLS-scoped.
      const where = and(
        eq(base.member.organizationId, tenantId),
        q
          ? or(ilike(base.user.name, `%${q}%`), ilike(base.user.email, `%${q}%`))
          : undefined,
      );
      const sortCol =
        sort === "name" ? base.user.name : sort === "email" ? base.user.email : base.member.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const [total] = await adminDb
        .select({ value: count() })
        .from(base.member)
        .innerJoin(base.user, eq(base.member.userId, base.user.id))
        .where(where);
      const rows = await adminDb
        .select({
          id: base.member.id,
          role: base.member.role,
          userId: base.member.userId,
          name: base.user.name,
          email: base.user.email,
          createdAt: base.member.createdAt,
        })
        .from(base.member)
        .innerJoin(base.user, eq(base.member.userId, base.user.id))
        .where(where)
        .orderBy(sortFn(sortCol))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return c.json({
        items: rows,
        meta: buildPaginationMeta(page, pageSize, total?.value ?? 0, sort, order),
      });
    },
  )
  // Change a staff member's role (admin+). The `member` table is a foundation
  // org table (not RLS-scoped), so it is filtered explicitly by organizationId
  // via adminDb — a member id from another tenant is simply Not Found here.
  // Guards, in order: escalation (no assigning a role above your own, no
  // managing someone who outranks you), owner grants require an owner actor,
  // and the final owner can never be demoted.
  .patch(
    "/members/:id/role",
    zValidator("json", updateMemberRoleSchema),
    async (c) => {
      const { tenantId, role } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { staff: ["update-role"] });
      const id = c.req.param("id");
      const { role: newRole } = c.req.valid("json");

      const [target] = await adminDb
        .select({
          id: base.member.id,
          userId: base.member.userId,
          role: base.member.role,
          email: base.user.email,
        })
        .from(base.member)
        .innerJoin(base.user, eq(base.member.userId, base.user.id))
        .where(
          and(
            eq(base.member.id, id),
            eq(base.member.organizationId, tenantId),
          ),
        )
        .limit(1);
      if (!target) throw new HttpError(404, "Member not found.");

      const currentRole = target.role as Role;
      // Escalation + management guard (shared with API-key minting).
      assertCanAssignRole(role, newRole, currentRole);

      // Last-owner protection: never demote the final owner out of the role.
      if (currentRole === "owner" && newRole !== "owner") {
        const [owners] = await adminDb
          .select({ n: count() })
          .from(base.member)
          .where(
            and(
              eq(base.member.organizationId, tenantId),
              eq(base.member.role, "owner"),
            ),
          );
        if ((owners?.n ?? 0) <= 1) {
          throw new HttpError(
            409,
            "Can't change the role of the last owner — promote another owner first.",
          );
        }
      }

      await adminDb
        .update(base.member)
        .set({ role: newRole })
        .where(
          and(
            eq(base.member.id, id),
            eq(base.member.organizationId, tenantId),
          ),
        );
      await recordStaffAudit(c, {
        action: "member.role_changed",
        targetType: "member",
        targetId: id,
        targetLabel: target.email,
        metadata: { from: currentRole, to: newRole },
      });
      // Best-effort — never block the role change on this write.
      const [actor] = await adminDb
        .select({ name: base.user.name, email: base.user.email })
        .from(base.user)
        .where(eq(base.user.id, c.var.tenant.userId))
        .limit(1);
      await withTenant(tenantId, (tx) =>
        tx.insert(tenantNotification).values({
          id: createId(),
          tenantId,
          recipientUserId: target.userId,
          type: "role_changed",
          title: `Your role was changed to ${newRole}`,
          body: null,
          href: "/dashboard/settings/members",
          actorUserId: c.var.tenant.userId,
          actorName: actor?.name || actor?.email || null,
        }),
      ).catch(() => {});
      return c.json({ member: { id, role: newRole } });
    },
  )
  // Remove a staff member (admin+). Org-filtered via adminDb. Can't remove
  // someone who outranks you, and the final owner can never be removed. On
  // success the removed user's sessions scoped to this org are revoked.
  .delete("/members/:id", async (c) => {
    const { tenantId, role } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { staff: ["remove"] });
    const id = c.req.param("id");

    const [target] = await adminDb
      .select({
        id: base.member.id,
        userId: base.member.userId,
        role: base.member.role,
        email: base.user.email,
      })
      .from(base.member)
      .innerJoin(base.user, eq(base.member.userId, base.user.id))
      .where(
        and(eq(base.member.id, id), eq(base.member.organizationId, tenantId)),
      )
      .limit(1);
    if (!target) throw new HttpError(404, "Member not found.");

    const currentRole = target.role as Role;
    // Can't remove someone who outranks you (an admin can't remove an owner).
    assertOutranks(role, currentRole);

    // Last-owner protection covers self-removal of the final owner too.
    if (currentRole === "owner") {
      const [owners] = await adminDb
        .select({ n: count() })
        .from(base.member)
        .where(
          and(
            eq(base.member.organizationId, tenantId),
            eq(base.member.role, "owner"),
          ),
        );
      if ((owners?.n ?? 0) <= 1) {
        throw new HttpError(
          409,
          "Can't remove the last owner — transfer ownership first.",
        );
      }
    }

    // Audit before the destructive change (best practice).
    await recordStaffAudit(c, {
      action: "member.removed",
      targetType: "member",
      targetId: id,
      targetLabel: target.email,
      metadata: { role: currentRole },
    });
    await adminDb
      .delete(base.member)
      .where(
        and(eq(base.member.id, id), eq(base.member.organizationId, tenantId)),
      );
    // Revoke the removed user's sessions scoped to this org (best-effort).
    await adminDb
      .delete(base.session)
      .where(
        and(
          eq(base.session.userId, target.userId),
          eq(base.session.activeOrganizationId, tenantId),
        ),
      );
    return c.json({ ok: true });
  })
  // Transfer ownership (owner-only). Atomically promotes the target to `owner`
  // and demotes the acting owner to `admin`, so there is always exactly one
  // owner and the workspace is never left ownerless.
  .post("/members/:id/transfer-ownership", async (c) => {
    const { tenantId, userId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { tenant: ["transfer-ownership"] });
    const id = c.req.param("id");

    const [target] = await adminDb
      .select({
        id: base.member.id,
        userId: base.member.userId,
        role: base.member.role,
        email: base.user.email,
      })
      .from(base.member)
      .innerJoin(base.user, eq(base.member.userId, base.user.id))
      .where(
        and(eq(base.member.id, id), eq(base.member.organizationId, tenantId)),
      )
      .limit(1);
    if (!target) throw new HttpError(404, "Member not found.");
    if (target.userId === userId) {
      throw new HttpError(400, "You already own this workspace.");
    }

    await adminDb.transaction(async (tx) => {
      await tx
        .update(base.member)
        .set({ role: "owner" })
        .where(
          and(eq(base.member.id, id), eq(base.member.organizationId, tenantId)),
        );
      await tx
        .update(base.member)
        .set({ role: "admin" })
        .where(
          and(
            eq(base.member.userId, userId),
            eq(base.member.organizationId, tenantId),
          ),
        );
    });
    await recordStaffAudit(c, {
      action: "member.ownership_transferred",
      targetType: "member",
      targetId: id,
      targetLabel: target.email,
      metadata: { newOwnerUserId: target.userId, previousOwnerUserId: userId },
    });
    return c.json({ ok: true });
  })

  // ── Invitations (admin+) — foundation factory (agora/invites) ──
  .route("/", inviteRoutes())

  .route("/", tenantLifecycleRoutes({ lifecycle }))

  // ── Chrono: venue-membership staff workflow (chrono/members module) ──
  // Mounted at "/member-profiles", NOT "/members" as the module plan
  // originally specified — this app already binds GET/PATCH/DELETE
  // "/members" + POST "/members/:id/transfer-ownership" above to the
  // foundation's Better Auth staff org-member management (a completely
  // different resource: staff, not customers). Mounting the new
  // ChronoMemberProfiles routes at "/members" would collide with those
  // existing routes. Extends the existing `customer` permission resource
  // (approve/reject are new actions on it) — see
  // .ai/plans/chrono/active/members/README.md, "Permission vocabulary".
  .route("/member-profiles", memberProfileRoutes())

  // ── Customers / DSAR (admin+): list, export, or delete one tenant_member ──
  // The customer pool is RLS-scoped, so all reads/writes go through withTenant.
  .get(
    "/customers",
    zValidator("query", listQuerySchema(["name", "email", "createdAt"])),
    async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { customer: ["read"] });
      const { page, pageSize, q, sort, order } = c.req.valid("query");
      const where = q
        ? or(
            ilike(base.tenantMember.name, `%${q}%`),
            ilike(base.tenantMember.email, `%${q}%`),
          )
        : undefined;
      const sortCol =
        sort === "name"
          ? base.tenantMember.name
          : sort === "email"
            ? base.tenantMember.email
            : base.tenantMember.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(base.tenantMember)
          .where(where);
        const rows = await tx
          .select({
            id: base.tenantMember.id,
            tenantId: base.tenantMember.tenantId,
            email: base.tenantMember.email,
            name: base.tenantMember.name,
            status: base.tenantMember.status,
            createdAt: base.tenantMember.createdAt,
          })
          .from(base.tenantMember)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });
      const items: Customer[] = rows.map(toCustomer);
      return c.json({
        items,
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    },
  )
  // Create a customer directly (admin+, temp-password flow). Password is hashed
  // before the tx opens; duplicate (tenantId, email) → 409. RLS-scoped.
  .post("/customers", zValidator("json", createCustomerSchema), async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["create"] });
    const { email, name, password } = c.req.valid("json");
    const toEmail = email.toLowerCase();
    const passwordHash = await hashMemberPassword(password);

    const created = await withTenant(tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: base.tenantMember.id })
        .from(base.tenantMember)
        .where(eq(base.tenantMember.email, toEmail))
        .limit(1);
      if (existing) return null;
      const [row] = await tx
        .insert(base.tenantMember)
        .values({ tenantId, email: toEmail, name, passwordHash })
        .returning({
          id: base.tenantMember.id,
          tenantId: base.tenantMember.tenantId,
          email: base.tenantMember.email,
          name: base.tenantMember.name,
          status: base.tenantMember.status,
          createdAt: base.tenantMember.createdAt,
        });
      return row ?? null;
    });
    if (!created) {
      throw new HttpError(409, "A customer with that email already exists.");
    }
    await recordStaffAudit(c, {
      action: "customer.created",
      targetType: "member",
      targetId: created.id,
      targetLabel: created.email,
    });
    return c.json({ customer: toCustomer(created) }, 201);
  })
  // Edit a customer's name and/or email (admin+). A changed email is re-checked
  // for tenant uniqueness → 409. RLS-scoped; a foreign id is Not Found.
  .patch("/customers/:id", zValidator("json", updateCustomerSchema), async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["update"] });
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    const newEmail = input.email?.toLowerCase();
    if (newEmail !== undefined) patch.email = newEmail;

    const updated = await withTenant(tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: base.tenantMember.id, email: base.tenantMember.email })
        .from(base.tenantMember)
        .where(eq(base.tenantMember.id, id))
        .limit(1);
      if (!existing) return { notFound: true as const };
      if (newEmail && newEmail !== existing.email) {
        const [dup] = await tx
          .select({ id: base.tenantMember.id })
          .from(base.tenantMember)
          .where(eq(base.tenantMember.email, newEmail))
          .limit(1);
        if (dup) return { conflict: true as const };
      }
      const [row] = await tx
        .update(base.tenantMember)
        .set(patch)
        .where(eq(base.tenantMember.id, id))
        .returning({
          id: base.tenantMember.id,
          tenantId: base.tenantMember.tenantId,
          email: base.tenantMember.email,
          name: base.tenantMember.name,
          status: base.tenantMember.status,
          createdAt: base.tenantMember.createdAt,
        });
      return { row: row! };
    });
    if ("notFound" in updated) throw new HttpError(404, "Customer not found.");
    if ("conflict" in updated) {
      throw new HttpError(409, "A customer with that email already exists.");
    }
    await recordStaffAudit(c, {
      action: "customer.updated",
      targetType: "member",
      targetId: id,
      targetLabel: updated.row.email,
    });
    return c.json({ customer: toCustomer(updated.row) });
  })
  // Suspend a customer (admin+): block auth and revoke live sessions.
  .post("/customers/:id/suspend", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["suspend"] });
    const id = c.req.param("id");
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .update(base.tenantMember)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(base.tenantMember.id, id))
        .returning({
          id: base.tenantMember.id,
          tenantId: base.tenantMember.tenantId,
          email: base.tenantMember.email,
          name: base.tenantMember.name,
          status: base.tenantMember.status,
          createdAt: base.tenantMember.createdAt,
        }),
    );
    if (!row) throw new HttpError(404, "Customer not found.");
    await revokeMemberSessions(tenantId, id);
    await recordStaffAudit(c, {
      action: "customer.suspended",
      targetType: "member",
      targetId: id,
      targetLabel: row.email,
    });
    return c.json({ customer: toCustomer(row) });
  })
  // Reactivate a suspended customer (admin+).
  .post("/customers/:id/reactivate", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["reactivate"] });
    const id = c.req.param("id");
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .update(base.tenantMember)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(base.tenantMember.id, id))
        .returning({
          id: base.tenantMember.id,
          tenantId: base.tenantMember.tenantId,
          email: base.tenantMember.email,
          name: base.tenantMember.name,
          status: base.tenantMember.status,
          createdAt: base.tenantMember.createdAt,
        }),
    );
    if (!row) throw new HttpError(404, "Customer not found.");
    await recordStaffAudit(c, {
      action: "customer.reactivated",
      targetType: "member",
      targetId: id,
      targetLabel: row.email,
    });
    return c.json({ customer: toCustomer(row) });
  })
  .get("/customers/:id/export", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["export"] });
    const id = c.req.param("id");
    const bundle = await exportMember(tenantId, id);
    if (!bundle) throw new HttpError(404, "Customer not found.");
    await recordStaffAudit(c, {
      action: "member.exported",
      targetType: "member",
      targetId: id,
    });
    return c.json(bundle);
  })
  .delete("/customers/:id", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { customer: ["delete"] });
    const id = c.req.param("id");
    const ok = await deleteMember(tenantId, id);
    if (!ok) throw new HttpError(404, "Customer not found.");
    await recordStaffAudit(c, {
      action: "member.deleted",
      targetType: "member",
      targetId: id,
    });
    return c.json({ ok: true });
  })

  // ── Chrono: branches (RLS-protected, admin+ mutations) — apps/chrono-api/src/modules/branch ──
  .route("/", branchRoutes())

  // ── Chrono: stations (RLS-protected, staff create/update, admin+ delete) — apps/chrono-api/src/modules/station ──
  .route("/", stationRoutes())

  // ── Chrono: station QR regenerate, staff-facing (reuses station:update) — apps/chrono-api/src/modules/qr ──
  .route("/", stationQrRoutes())

  // ── Chrono: reservations (RLS-protected, staff/admin/owner read+manage) — apps/chrono-api/src/modules/reservation ──
  .route("/", reservationRoutes())

  // ── Chrono: shifts (RLS-protected, any staff/admin/owner may open/close) — apps/chrono-api/src/modules/shift ──
  .route("/", shiftRoutes())

  // ── Chrono: onboarding checklist (RLS-protected, ungated — visibility only) — apps/chrono-api/src/modules/onboarding ──
  .route("/", onboardingRoutes())

  // ── Chrono: reconciliation (RLS-protected, staff/admin read-only aggregation) — apps/chrono-api/src/modules/reconciliation ──
  .route("/reconciliation", reconciliationRoutes())

  // ── Chrono: devices, staff-facing (RLS-protected, list ungated, approve/revoke/manage admin+) — apps/chrono-api/src/modules/device ──
  .route("/devices", staffDeviceRoutes())

  // ── Chrono: wallets, staff-facing (RLS-protected, staff credit/debit, admin+ adjust) — apps/chrono-api/src/modules/wallet ──
  .route("/", walletRoutes())

  // ── Chrono: payments, staff-facing (RLS-protected, staff create/pay, admin+ void/refund) — apps/chrono-api/src/modules/payment ──
  .route("/", paymentRoutes())

  // ── Chrono: credits, staff-facing (RLS-protected, staff sell/consume, admin+ grant/adjust/manageProducts) — apps/chrono-api/src/modules/credit ──
  .route("/", creditRoutes())

  // ── Chrono: pos, staff-facing (RLS-protected, staff sell, admin+ void/manageProducts) — apps/chrono-api/src/modules/pos ──
  .route("/", posRoutes())

  // ── Chrono: loyalty, staff-facing (RLS-protected, staff read/manage, admin+ adjust) — apps/chrono-api/src/modules/loyalty ──
  .route("/", loyaltyRoutes())

  // ── Chrono: vouchers, staff-facing (RLS-protected, staff/admin/owner read+manage) — apps/chrono-api/src/modules/voucher ──
  .route("/", voucherRoutes())

  // ── Chrono: promos, staff-facing (RLS-protected, staff read, admin+ manage) — apps/chrono-api/src/modules/promo ──
  .route("/", promoRoutes())

  // ── Chrono: sessions, staff-facing (RLS-protected, staff+admin+owner create/update, no split) — apps/chrono-api/src/modules/session ──
  .route("/", sessionRoutes())

  // ── Chrono: reports, staff-facing (RLS-protected, read-only, staff branch-scoped, admin+ unscoped/wallet) — apps/chrono-api/src/modules/report ──
  .route("/", reportRoutes())

  // ── Chrono: security alerts, staff-facing (RLS-protected, staff/admin/owner read+manage) — apps/chrono-api/src/modules/security-alert ──
  .route("/security-alerts", securityAlertRoutes())

  // ── Chrono: inquiries, staff-facing (RLS-protected, staff/admin/owner read+manage) — apps/chrono-api/src/modules/inquiry ──
  .route("/inquiries", inquiryRoutes())

  // ── Chrono: landing-page settings editor, staff-facing (RLS-protected, admin+ manage) — apps/chrono-api/src/modules/landing-page ──
  .route("/landing-page", landingPageRoutes())

  // ── Custom domains (RLS-protected) — foundation factory (agora/domains) ──
  .route("/", domainRoutes())

  // ── API keys (admin+, RLS-protected) — foundation factory (agora/server/routes) ──
  .route("/", apiKeyRoutes())
  // ── Webhooks (admin+, RLS-protected) — foundation factory (agora/webhooks) ──
  .route("/", webhookRoutes())

  // ── Billing (read: admin+; checkout/portal: owner-only) — foundation factory (agora/billing/routes) ──
  .route("/", billingRoutes({ tenantHostUrl }))

  // ── Security: MFA/policy/SSO — foundation factory (agora/server/routes) ──
  .route("/", securityRoutes())

  // ── Integrations: per-tenant provider connections (email is the only category) ──
  // The provider registry lives in agora/server; here we CRUD the encrypted
  // tenant_integration row and never return the stored key (only hasApiKey).
  .get("/integrations", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { integration: ["read"] });
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, tenantId)),
    );
    const email = rows.find((r) => r.category === "email");
    const storage = rows.find((r) => r.category === "storage");
    return c.json({
      email: email ? toEmailIntegration(email) : null,
      storage: storage ? toStorageIntegration(storage) : null,
    });
  })
  .put(
    "/integrations/email",
    zValidator("json", upsertEmailIntegrationSchema),
    async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
      const input = c.req.valid("json");

      const [existing] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(tenantIntegration)
          .where(
            and(
              eq(tenantIntegration.tenantId, tenantId),
              eq(tenantIntegration.category, "email"),
            ),
          )
          .limit(1),
      );

      // A key is required the first time; on update it may be omitted to keep the
      // stored one. Encryption needs SSO_ENC_KEY configured.
      if (!existing && !input.apiKey) {
        throw new HttpError(
          400,
          "An API key is required to create an email integration.",
        );
      }
      let secretEnc = existing?.secretEnc ?? null;
      if (input.apiKey) {
        if (!hasEncryptionKey()) {
          throw new Error("SSO_ENC_KEY is not configured on the server.");
        }
        secretEnc = encryptSecret(input.apiKey);
      }

      const config = {
        fromAddress: input.fromAddress,
        ...(input.fromName ? { fromName: input.fromName } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };
      const values = {
        category: "email" as const,
        provider: input.provider,
        config,
        secretEnc,
        enabled: input.enabled,
        updatedAt: new Date(),
      };
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .insert(tenantIntegration)
          .values({ id: createId(), tenantId, ...values })
          .onConflictDoUpdate({
            target: [tenantIntegration.tenantId, tenantIntegration.category],
            set: values,
          })
          .returning(),
      );
      await recordStaffAudit(c, {
        action: "integration.email_updated",
        targetType: "integration",
        targetId: row?.id,
        targetLabel: input.provider,
        metadata: { provider: input.provider, enabled: input.enabled },
      });
      return c.json({ email: toEmailIntegration(row!) });
    },
  )
  .delete("/integrations/email", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
    const deleted = await withTenant(tenantId, (tx) =>
      tx
        .delete(tenantIntegration)
        .where(
          and(
            eq(tenantIntegration.tenantId, tenantId),
            eq(tenantIntegration.category, "email"),
          ),
        )
        .returning(),
    );
    if (deleted.length === 0) {
      throw new HttpError(404, "No email integration configured.");
    }
    await recordStaffAudit(c, {
      action: "integration.email_deleted",
      targetType: "integration",
      targetId: deleted[0]?.id,
    });
    return c.json({ ok: true });
  })
  // Send a branded test email to the caller's own address through the resolved
  // tenant sender (or the platform fallback when none is enabled).
  .post("/integrations/email/test", async (c) => {
    const { tenantId, userId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
    const [u] = await adminDb
      .select({ email: base.user.email })
      .from(base.user)
      .where(eq(base.user.id, userId))
      .limit(1);
    if (!u?.email) {
      throw new HttpError(400, "Your account has no email address to test with.");
    }
    const [b] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantBranding)
        .where(eq(tenantBranding.tenantId, tenantId))
        .limit(1),
    );
    const email = renderBrandedEmail(
      {
        displayName: b?.displayName ?? null,
        emailFromName: b?.emailFromName ?? null,
        emailReplyTo: b?.emailReplyTo ?? null,
        emailLogoUrl: b?.emailLogoUrl ?? null,
        primaryColor: b?.primaryColor ?? null,
        supportEmail: b?.supportEmail ?? null,
      },
      {
        subject: "Test email from your workspace",
        bodyHtml:
          "<p>This is a test message confirming your email integration is configured correctly.</p>",
      },
    );
    const sender = await resolveEmailSender(tenantId);
    await sender.send({ ...email, to: u.email });
    await recordStaffAudit(c, {
      action: "integration.email_tested",
      targetType: "integration",
      metadata: { provider: sender.provider },
    });
    return c.json({ ok: true, provider: sender.provider });
  })

  // ── Integrations: per-tenant object storage (bring-your-own-bucket) ──
  // The tenant's S3 config lives in `config` (accessKeyId + bucket/region/…);
  // only the secret access key is encrypted into `secret_enc` and never
  // returned (hasSecret only). Platform env storage stays the fallback.
  .put(
    "/integrations/storage",
    zValidator("json", upsertStorageIntegrationSchema),
    async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
      const input = c.req.valid("json");

      // SSRF guard: a tenant-supplied endpoint/publicBaseUrl must be a public
      // https URL (rejects internal hosts / cloud metadata / private ranges).
      if (input.endpoint) await assertPublicHttpsUrl(input.endpoint);
      if (input.publicBaseUrl) await assertPublicHttpsUrl(input.publicBaseUrl);

      const [existing] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(tenantIntegration)
          .where(
            and(
              eq(tenantIntegration.tenantId, tenantId),
              eq(tenantIntegration.category, "storage"),
            ),
          )
          .limit(1),
      );

      // The secret access key is required the first time; on update it may be
      // omitted to keep the stored one. Encryption needs SSO_ENC_KEY configured.
      // If accessKeyId is missing, allow a folder-only save without secrets.
      if (!existing && !input.secretAccessKey && input.accessKeyId) {
        throw new HttpError(
          400,
          "A secret access key is required to create a storage integration.",
        );
      }
      let secretEnc = existing?.secretEnc ?? null;
      if (input.secretAccessKey) {
        if (!hasEncryptionKey()) {
          throw new Error("SSO_ENC_KEY is not configured on the server.");
        }
        secretEnc = encryptSecret(input.secretAccessKey);
      }

      const config = {
        bucket: input.bucket,
        region: input.region,
        accessKeyId: input.accessKeyId,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
        ...(input.folder ? { folder: input.folder } : {}),
      };
      const values = {
        category: "storage" as const,
        provider: input.provider,
        config,
        secretEnc,
        enabled: input.enabled,
        updatedAt: new Date(),
      };
      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .insert(tenantIntegration)
          .values({ id: createId(), tenantId, ...values })
          .onConflictDoUpdate({
            target: [tenantIntegration.tenantId, tenantIntegration.category],
            set: values,
          })
          .returning(),
      );
      await recordStaffAudit(c, {
        action: "integration.storage_updated",
        targetType: "integration",
        targetId: row?.id,
        targetLabel: input.provider,
        metadata: {
          provider: input.provider,
          bucket: input.bucket,
          region: input.region,
          enabled: input.enabled,
        },
      });
      return c.json({ storage: toStorageIntegration(row!) });
    },
  )
  .delete("/integrations/storage", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
    const deleted = await withTenant(tenantId, (tx) =>
      tx
        .delete(tenantIntegration)
        .where(
          and(
            eq(tenantIntegration.tenantId, tenantId),
            eq(tenantIntegration.category, "storage"),
          ),
        )
        .returning(),
    );
    if (deleted.length === 0) {
      throw new HttpError(404, "No storage integration configured.");
    }
    await recordStaffAudit(c, {
      action: "integration.storage_deleted",
      targetType: "integration",
      targetId: deleted[0]?.id,
    });
    return c.json({ ok: true });
  })
  // Test connection: write a tiny probe object through the resolved adapter
  // (the tenant bucket when enabled, else the platform fallback) then delete it.
  .post("/integrations/storage/test", async (c) => {
    const { tenantId } = c.var.tenant;
    requirePermission(c.var.tenant.permissions, { integration: ["manage"] });
    const storage = await resolveStorage(tenantId);
    const key = `integration-tests/${tenantId}/probe-${createId()}.txt`;
    await storage.put({
      key,
      bytes: new TextEncoder().encode("agora storage probe"),
      contentType: "text/plain",
    });
    await storage.delete(key);
    await recordStaffAudit(c, {
      action: "integration.storage_tested",
      targetType: "integration",
      metadata: { provider: storage.provider },
    });
    return c.json({ ok: true, provider: storage.provider });
  });

export type RpcType = typeof rpc;

/**
 * Staff realtime-connection defaults (realtime-updates Phase 1,
 * `.ai/plans/chrono/active/realtime-updates/README.md`) — a browser tab
 * re-handshakes periodically to pick up revoked access, unlike a long-lived
 * device/kiosk mount (Phase 3's own, separate `limits`).
 *
 * Values copied verbatim from `apps/agora-api`'s own staff mount
 * (`STAFF_REALTIME_LIMITS`), which this app's staff dashboard shares the same
 * actor shape with (a member session cookie via `tenantMiddleware`).
 */
export const CHRONO_STAFF_REALTIME_LIMITS: RealtimeLimits = {
  maxLifetimeMs: 15 * 60 * 1000,
  revalidateEveryMs: 5 * 60 * 1000,
  heartbeatMs: 30_000,
  maxPerActor: 8,
  maxPerTenant: 200,
  maxFrameBytes: 8 * 1024,
  inboundFramesPerMin: 120,
  requireOrigin: true,
};

/**
 * Mount the staff realtime upgrade route at `/rpc/realtime`, inside this
 * sub-app's existing `.use("*", tenantMiddleware())` chain (registered
 * above) — so it inherits the maintenance-mode gate and usage-metering
 * middleware automatically, and only needs to re-check what
 * `tenantMiddleware` doesn't already cover (Origin — CSWSH). Called once
 * from `app.ts`, which is the one place `upgradeWebSocket` (from
 * `createNodeWebSocket({ app })`) and the staff `resolveActor` (built from
 * this app's own CORS origin config) exist.
 *
 * Mirrors `apps/agora-api/src/routes/rpc.ts`'s own `mountRealtimeRoute`
 * exactly, swapping in Chrono's `validateChronoScopes` for the foundation
 * scaffold's "accept no scope kinds" validator.
 */
export function mountRealtimeRoute(
  upgradeWebSocket: UpgradeWebSocket,
  resolveActor: ResolveActor,
): void {
  rpc.get(
    "/realtime",
    createRealtimeRoute({
      upgradeWebSocket,
      resolveActor,
      validateScopes: validateChronoScopes,
      limits: CHRONO_STAFF_REALTIME_LIMITS,
    }),
  );
}

/** Map a customer (tenant_member) row → wire contract (never the password hash). */
function toCustomer(row: {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  status: string;
  createdAt: Date;
}): Customer {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    name: row.name,
    status: row.status as Customer["status"],
    createdAt: row.createdAt.toISOString(),
  };
}


/** Map an email integration row → wire contract (never the stored API key). */
function toEmailIntegration(
  row: typeof tenantIntegration.$inferSelect,
): EmailIntegration {
  const cfg = (row.config ?? {}) as {
    fromAddress?: string;
    fromName?: string;
    replyTo?: string;
  };
  return {
    id: row.id,
    tenantId: row.tenantId,
    category: "email",
    provider: row.provider as EmailIntegration["provider"],
    fromAddress: cfg.fromAddress ?? "",
    fromName: cfg.fromName ?? null,
    replyTo: cfg.replyTo ?? null,
    enabled: row.enabled,
    hasApiKey: !!row.secretEnc,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a storage integration row → wire contract (never the secret access key). */
function toStorageIntegration(
  row: typeof tenantIntegration.$inferSelect,
): StorageIntegration {
  const cfg = (row.config ?? {}) as {
    bucket?: string;
    region?: string;
    accessKeyId?: string;
    endpoint?: string;
    publicBaseUrl?: string;
  };
  return {
    id: row.id,
    tenantId: row.tenantId,
    category: "storage",
    provider: row.provider as StorageIntegration["provider"],
    folder: (row.config as any)?.folder ?? null,
    bucket: cfg.bucket ?? "",
    region: cfg.region ?? "",
    endpoint: cfg.endpoint ?? null,
    publicBaseUrl: cfg.publicBaseUrl ?? null,
    accessKeyId: cfg.accessKeyId ?? "",
    enabled: row.enabled,
    hasSecret: !!row.secretEnc,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

