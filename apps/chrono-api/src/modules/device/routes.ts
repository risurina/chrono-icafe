import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  withTenant,
  withAdmin,
  eq,
  and,
  or,
  not,
  isNull,
  lt,
  asc,
  desc,
  count,
  gte,
  type TenantTx,
} from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator, hashApiKey, verifyApiKey } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { publishStationTransition } from "../station/routes";
import { chronoDevice, chronoDeviceProvisioningToken, chronoDeviceCommand } from "./schema";
import {
  createProvisioningTokenSchema,
  approveDeviceSchema,
  relinkDeviceSchema,
  deviceListQuerySchema,
  pairDeviceSchema,
  authDeviceSchema,
  heartbeatSchema,
  issueDeviceCommandSchema,
} from "./contracts";
import { getEffectiveCommandStatus } from "./command-status";
import { requireDeviceBearerAuth, type DeviceAuthVars } from "./device-auth-middleware";
import { closeConnections, getRealtimeProvider, tenantScopeChannel } from "agora/realtime";
import { createRateLimiter } from "agora/server";
import { chronoSecurityAlert } from "../security-alert/schema";
import { deviceReportSecurityAlertSchema } from "../security-alert/contracts";

// A device could be compromised/misbehaving and spam alerts; 10/hour is
// generous for genuine tamper/incident events (rare) while bounding the
// worst case (mirrors devicePairCodeLimiter/deviceAuthTokenLimiter's own
// per-secret-scale numbers in app.ts, scaled up slightly since this is a
// post-auth, already-approved-device path, not a credential-guessing one).
const deviceSecurityAlertLimiter = createRateLimiter(10, 60 * 60 * 1000, "device-security-alert");

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // Drizzle sometimes wraps the real pg error, putting the SQLSTATE on
  // `cause.code` rather than `code` itself — check both rather than assume
  // one shape (found via a latent bug in this same check copied into the
  // qr module, .ai/plans/chrono/active/qr/README.md Phase 3).
  if ("code" in err && err.code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505"
  );
}

// A command not acked within 15 minutes of issuance is treated as expired
// (Phase 3's own "offline/expiry decision") — lazily, at read time, via
// `getEffectiveCommandStatus`, never a background sweep in this first
// version.
const DEVICE_COMMAND_EXPIRY_MS = 15 * 60 * 1000;

// Unambiguous uppercase alphabet — excludes O/0 and I/1, which are read aloud
// at a physical PC and easily confused (security-hardening Phase 1).
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;

/** Cryptographically random pairing code, ≥10 chars, no ambiguous glyphs. */
function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i]! % PAIRING_CODE_ALPHABET.length];
  }
  return out;
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

/** Resolve a branch inside the caller's own tenant, or 404 (never a leaked cross-tenant signal). */
async function requireOwnBranch(tx: TenantTx, tenantId: string, branchId: string) {
  const [branch] = await tx
    .select({ id: chronoBranch.id })
    .from(chronoBranch)
    .where(and(eq(chronoBranch.id, branchId), eq(chronoBranch.tenantId, tenantId)))
    .limit(1);
  if (!branch) {
    throw new HttpError(404, "Branch not found.");
  }
}

/** Resolve a device inside the caller's own tenant, or 404 (never a leaked cross-tenant signal). */
async function requireOwnDevice(tx: TenantTx, tenantId: string, id: string) {
  const [device] = await tx
    .select()
    .from(chronoDevice)
    .where(and(eq(chronoDevice.id, id), eq(chronoDevice.tenantId, tenantId)))
    .limit(1);
  if (!device) {
    throw new HttpError(404, "Device not found.");
  }
  return device;
}

/**
 * Resolve a station inside the caller's own tenant AND the device's own
 * branch, or 404 — mirrors `stations`' own `requireOwnGroupInBranch` pattern.
 */
async function requireOwnStationInBranch(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  stationId: string,
) {
  const [station] = await tx
    .select({ id: chronoStation.id })
    .from(chronoStation)
    .where(
      and(
        eq(chronoStation.id, stationId),
        eq(chronoStation.tenantId, tenantId),
        eq(chronoStation.branchId, branchId),
      ),
    )
    .limit(1);
  if (!station) {
    throw new HttpError(404, "Station not found.");
  }
}

/**
 * Application-level pre-check mirroring the DB partial unique index
 * (`chrono_device_station_approved_idx`): at most one APPROVED device may be
 * linked to a given station. Excludes `excludeDeviceId` so re-approving/
 * relinking the SAME device onto the station it already holds is not a
 * false-positive conflict. This is belt-and-suspenders — the DB constraint is
 * the real guard under a concurrent-approval race; this just returns a clean
 * 409 before that constraint would fire.
 */
async function assertStationNotAlreadyApproved(
  tx: TenantTx,
  tenantId: string,
  stationId: string,
  excludeDeviceId?: string,
) {
  const conds = [
    eq(chronoDevice.tenantId, tenantId),
    eq(chronoDevice.stationId, stationId),
    eq(chronoDevice.status, "approved"),
  ];
  const [conflict] = await tx
    .select({ id: chronoDevice.id })
    .from(chronoDevice)
    .where(and(...conds))
    .limit(1);
  if (conflict && conflict.id !== excludeDeviceId) {
    throw new HttpError(409, "Station already linked to another approved device.");
  }
}

/** Resolve or create the target station for an approve/relink request. */
async function resolveTargetStation(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  input: { stationId?: string; newStationName?: string; newStationNumber?: string },
): Promise<string> {
  if (input.stationId) {
    await requireOwnStationInBranch(tx, tenantId, branchId, input.stationId);
    return input.stationId;
  }
  if (!input.newStationName || !input.newStationNumber) {
    throw new HttpError(
      400,
      "Provide either stationId or both newStationName and newStationNumber.",
    );
  }
  try {
    const [row] = await tx
      .insert(chronoStation)
      .values({
        id: createId(),
        tenantId,
        branchId,
        name: input.newStationName,
        stationNumber: input.newStationNumber,
      })
      .returning({ id: chronoStation.id });
    if (!row) {
      throw new Error("Failed to create station.");
    }
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "A station with that number already exists in this branch.");
    }
    throw err;
  }
}

export function staffDeviceRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    // GET / — ungated (any authenticated tenant member can view the device
    // list — matches branches'/stations' own ungated-list precedent).
    .get("/", zValidator("query", deviceListQuerySchema), async (c) => {
      const { tenantId } = c.var.tenant;
      const { page, pageSize, branchId, status, sort, order } = c.req.valid("query");
      const conds = [];
      if (branchId) conds.push(eq(chronoDevice.branchId, branchId));
      if (status) conds.push(eq(chronoDevice.status, status));
      const where = conds.length ? and(...conds) : undefined;
      const sortCol =
        sort === "hostname"
          ? chronoDevice.hostname
          : sort === "lastSeenAt"
            ? chronoDevice.lastSeenAt
            : chronoDevice.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(chronoDevice)
          .where(where);
        const rows = await tx
          .select()
          .from(chronoDevice)
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
    })

    // POST /provisioning-tokens — device:manage.
    .post(
      "/provisioning-tokens",
      zValidator("json", createProvisioningTokenSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { device: ["manage"] });
        const input = c.req.valid("json");

        const pairingCodeExpiresAt = new Date(
          Date.now() + input.pairingCodeTtlMinutes * 60_000,
        );

        // Retry on a unique-violation against the partial (status='active')
        // index instead of surfacing the collision to the caller — the
        // generator has ~1.6e14 possible codes, so a collision against the
        // small set of currently-active codes is exceedingly rare, but must
        // never silently mint a duplicate.
        const MAX_ATTEMPTS = 5;
        let created: typeof chronoDeviceProvisioningToken.$inferSelect | undefined;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const pairingCode = generatePairingCode();
          try {
            created = await withTenant(tenantId, async (tx) => {
              await requireOwnBranch(tx, tenantId, input.branchId);
              const [row] = await tx
                .insert(chronoDeviceProvisioningToken)
                .values({
                  id: createId(),
                  tenantId,
                  branchId: input.branchId,
                  name: input.name,
                  pairingCode,
                  pairingCodeExpiresAt,
                  status: "active",
                  maxUses: input.maxUses,
                })
                .returning();
              return row;
            });
            break;
          } catch (err) {
            if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS - 1) continue;
            throw err;
          }
        }
        if (!created) {
          throw new Error("Failed to generate a unique pairing code.");
        }

        await recordStaffAudit(c, {
          action: "device.pairing_token_created",
          targetType: "deviceProvisioningToken",
          targetId: created?.id,
          targetLabel: created?.name,
        });

        // This is the one place a secret-shaped value is legitimately
        // returned — the pairing code is short-lived and meant to be read
        // aloud at the physical PC. The device's own bearer token is never
        // re-exposed after /auth.
        return c.json({ provisioningToken: created }, 201);
      },
    )

    // GET /provisioning-tokens — device:manage. Never returns tokenHash.
    .get("/provisioning-tokens", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["manage"] });

      const rows = await withTenant(tenantId, (tx) =>
        tx
          .select({
            id: chronoDeviceProvisioningToken.id,
            tenantId: chronoDeviceProvisioningToken.tenantId,
            branchId: chronoDeviceProvisioningToken.branchId,
            name: chronoDeviceProvisioningToken.name,
            pairingCode: chronoDeviceProvisioningToken.pairingCode,
            pairingCodeExpiresAt: chronoDeviceProvisioningToken.pairingCodeExpiresAt,
            status: chronoDeviceProvisioningToken.status,
            maxUses: chronoDeviceProvisioningToken.maxUses,
            useCount: chronoDeviceProvisioningToken.useCount,
            createdAt: chronoDeviceProvisioningToken.createdAt,
            updatedAt: chronoDeviceProvisioningToken.updatedAt,
          })
          .from(chronoDeviceProvisioningToken)
          .orderBy(desc(chronoDeviceProvisioningToken.createdAt)),
      );

      return c.json({ items: rows });
    })

    // POST /provisioning-tokens/:id/revoke — device:manage.
    .post("/provisioning-tokens/:id/revoke", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["manage"] });
      const id = c.req.param("id");

      const [updated] = await withTenant(tenantId, (tx) =>
        tx
          .update(chronoDeviceProvisioningToken)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(
            and(
              eq(chronoDeviceProvisioningToken.id, id),
              eq(chronoDeviceProvisioningToken.tenantId, tenantId),
            ),
          )
          .returning(),
      );
      if (!updated) {
        throw new HttpError(404, "Provisioning token not found.");
      }

      await recordStaffAudit(c, {
        action: "device.pairing_token_revoked",
        targetType: "deviceProvisioningToken",
        targetId: updated.id,
        targetLabel: updated.name,
      });
      return c.json({ provisioningToken: updated });
    })

    // POST /:id/approve — device:approve.
    .post("/:id/approve", zValidator("json", approveDeviceSchema), async (c) => {
      const { tenantId, userId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["approve"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const { device: updated, station: approvedStation } = await withTenant(tenantId, async (tx) => {
        const device = await requireOwnDevice(tx, tenantId, id);
        const stationId = await resolveTargetStation(tx, tenantId, device.branchId, input);
        await assertStationNotAlreadyApproved(tx, tenantId, stationId, device.id);

        const [row] = await tx
          .update(chronoDevice)
          .set({
            status: "approved",
            stationId,
            approvedByUserId: userId,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(chronoDevice.id, id), eq(chronoDevice.tenantId, tenantId)))
          .returning();

        // The station linked above may be pre-existing (relink) or just
        // created by resolveTargetStation (a brand-new kiosk) — either way,
        // its current row is what the realtime publish below announces.
        const [station] = await tx
          .select({ id: chronoStation.id, branchId: chronoStation.branchId, status: chronoStation.status })
          .from(chronoStation)
          .where(and(eq(chronoStation.id, stationId), eq(chronoStation.tenantId, tenantId)))
          .limit(1);

        return { device: row, station };
      });

      await recordStaffAudit(c, {
        action: "device.approved",
        targetType: "device",
        targetId: updated?.id,
        targetLabel: updated?.hostname,
      });
      if (approvedStation) {
        await publishStationTransition(tenantId, approvedStation);
      }
      return c.json({ device: updated });
    })

    // POST /:id/revoke — device:revoke.
    .post("/:id/revoke", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["revoke"] });
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        await requireOwnDevice(tx, tenantId, id);
        // Does not touch the linked station's own `status` column — that's
        // sessions'/floor-occupancy's concern once it exists.
        const [row] = await tx
          .update(chronoDevice)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(and(eq(chronoDevice.id, id), eq(chronoDevice.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "device.revoked",
        targetType: "device",
        targetId: updated?.id,
        targetLabel: updated?.hostname,
      });
      // Fast path: close the device's live socket immediately rather than
      // waiting for the next revalidateEveryMs re-validation tick to catch
      // the now-non-approved status (realtime-updates plan, Phase 3).
      if (updated) {
        await closeConnections({ tenantId, actorKey: updated.id });
      }
      return c.json({ device: updated });
    })

    // PATCH /:id/link — device:manage.
    .patch("/:id/link", zValidator("json", relinkDeviceSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["manage"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const device = await requireOwnDevice(tx, tenantId, id);
        await requireOwnStationInBranch(tx, tenantId, device.branchId, input.stationId);
        await assertStationNotAlreadyApproved(tx, tenantId, input.stationId, device.id);

        const [row] = await tx
          .update(chronoDevice)
          .set({ stationId: input.stationId, updatedAt: new Date() })
          .where(and(eq(chronoDevice.id, id), eq(chronoDevice.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "device.relinked",
        targetType: "device",
        targetId: updated?.id,
        targetLabel: updated?.hostname,
      });
      // Force a reconnect so the device's next resolveActor pass (immediate,
      // since it is still approved) picks up its new station linkage — the
      // channel identity (device:{deviceId}) is unchanged, but this keeps the
      // "a mutation to this device closes its stale connection" rule uniform
      // across revoke/relink rather than special-casing relink as exempt.
      if (updated) {
        await closeConnections({ tenantId, actorKey: updated.id });
      }
      return c.json({ device: updated });
    })

    // GET /:id/commands — device:manage. Command visibility is the same
    // hardware-trust tier as issuing one (no read/write split), unlike the
    // ungated device list above. Applies `getEffectiveCommandStatus` so a
    // stale `pending`/`delivered` row past its `expiresAt` reads as
    // "expired" without a background sweep.
    .get("/:id/commands", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["manage"] });
      const id = c.req.param("id");

      const rows = await withTenant(tenantId, async (tx) => {
        await requireOwnDevice(tx, tenantId, id);
        return tx
          .select()
          .from(chronoDeviceCommand)
          .where(and(eq(chronoDeviceCommand.deviceId, id), eq(chronoDeviceCommand.tenantId, tenantId)))
          .orderBy(desc(chronoDeviceCommand.issuedAt));
      });

      const now = new Date();
      const items = rows.map((row) => ({
        ...row,
        status: getEffectiveCommandStatus(
          row.status as "pending" | "delivered" | "acked" | "expired",
          row.expiresAt,
          now,
        ),
      }));

      return c.json({ items });
    })

    // POST /:id/commands — device:manage. Writes a `pending` command row
    // (the source of truth), then best-effort pushes it over the device's
    // open realtime connection if one exists — the push is latency-avoidance
    // only; there is no delivery ack at the transport layer, so "delivered"
    // here means "we attempted the push", not "the device received it". The
    // real signal is the `command-ack` inbound frame handled in
    // `realtime-actor.ts`.
    .post("/:id/commands", zValidator("json", issueDeviceCommandSchema), async (c) => {
      const { tenantId, userId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { device: ["manage"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const expiresAt = new Date(Date.now() + DEVICE_COMMAND_EXPIRY_MS);

      const created = await withTenant(tenantId, async (tx) => {
        await requireOwnDevice(tx, tenantId, id);
        const [row] = await tx
          .insert(chronoDeviceCommand)
          .values({
            id: createId(),
            tenantId,
            deviceId: id,
            type: input.type,
            status: "pending",
            issuedByUserId: userId,
            expiresAt,
          })
          .returning();
        return row;
      });
      if (!created) {
        throw new Error("Failed to create device command.");
      }

      let result = created;
      try {
        await getRealtimeProvider().publish(
          tenantScopeChannel(tenantId, `device:${id}`),
          "device.command",
          { commandId: created.id, type: created.type, expiresAt: created.expiresAt },
        );
        const [updated] = await withTenant(tenantId, (tx) =>
          tx
            .update(chronoDeviceCommand)
            .set({ status: "delivered", deliveredAt: new Date() })
            .where(and(eq(chronoDeviceCommand.id, created.id), eq(chronoDeviceCommand.tenantId, tenantId)))
            .returning(),
        );
        if (updated) result = updated;
      } catch {
        // Best-effort — the device may simply be offline right now. The
        // queued `pending` row remains the source of truth.
      }

      await recordStaffAudit(c, {
        action: "device.command_issued",
        targetType: "device",
        targetId: id,
        targetLabel: created.type,
        metadata: { commandId: created.id, type: created.type },
      });

      return c.json({ command: result }, 201);
    });
}

/** SHA-256 hash + raw secret pair for a freshly minted bearer credential. */
function mintCredential(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashApiKey(secret) };
}

/**
 * Device-facing routes (Phase 3 / Open Question 1) — the PC-client hardware
 * itself calls these, with NO Better Auth session and NO tenant membership
 * row. Mounted directly on `app` in app.ts via
 * `.route("/api/v1/device", deviceAuthRoutes())`, outside `/rpc` and outside
 * `tenantMiddleware()`. Do not gate any of these with `requirePermission` —
 * see the module's "two disjoint route surfaces" note at the top of
 * .ai/plans/chrono/active/devices/README.md.
 */
export function deviceAuthRoutes() {
  return new Hono<{ Variables: DeviceAuthVars }>()
    // POST /pair — unauthenticated; the pairing code itself is the
    // short-TTL secret. Cross-tenant lookup by pairingCode via withAdmin
    // (Open Question 1, step 2).
    .post("/pair", zValidator("json", pairDeviceSchema), async (c) => {
      const { pairingCode } = c.req.valid("json");

      const [row] = await withAdmin((tx) =>
        tx
          .select()
          .from(chronoDeviceProvisioningToken)
          .where(
            and(
              eq(chronoDeviceProvisioningToken.pairingCode, pairingCode),
              eq(chronoDeviceProvisioningToken.status, "active"),
              gte(chronoDeviceProvisioningToken.pairingCodeExpiresAt, new Date()),
            ),
          )
          .limit(1),
      );
      // Never distinguish invalid-vs-expired-vs-unknown.
      if (!row) {
        throw new HttpError(400, "Invalid or expired pairing code.");
      }

      const { secret, hash } = mintCredential();
      // Provisioning tokens are reusable across many PCs cloned from the same
      // golden image (maxUses/useCount) — 24h is long enough to cover a
      // realistic image-cloning/rollout window without being indefinite.
      const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60_000);
      const now = new Date();

      // Single-redemption enforcement (security-hardening Phase 1, decision
      // recorded in .ai/plans/chrono/archive/devices/README.md): once /pair
      // has minted a tokenHash that /auth has NOT yet consumed (useCount
      // still 0) and that hasn't expired, a second /pair for the same code is
      // refused rather than overwriting the live credential out from under a
      // PC that already redeemed it. True simultaneous multi-PC pairing from
      // one code is not supported — /auth's own useCount/maxUses reuse is the
      // supported golden-image path, once a PC has authenticated. The WHERE
      // clause is the single source of truth (not the earlier SELECT), so a
      // concurrent /pair race can't both win.
      const [claimed] = await withTenant(row.tenantId, (tx) =>
        tx
          .update(chronoDeviceProvisioningToken)
          .set({ tokenHash: hash, tokenExpiresAt, updatedAt: now })
          .where(
            and(
              eq(chronoDeviceProvisioningToken.id, row.id),
              or(
                isNull(chronoDeviceProvisioningToken.tokenHash),
                not(eq(chronoDeviceProvisioningToken.useCount, 0)),
                isNull(chronoDeviceProvisioningToken.tokenExpiresAt),
                lt(chronoDeviceProvisioningToken.tokenExpiresAt, now),
              ),
            ),
          )
          .returning({ id: chronoDeviceProvisioningToken.id }),
      );
      if (!claimed) {
        throw new HttpError(
          409,
          "This pairing code has already been redeemed and is awaiting device authentication.",
        );
      }

      // The one place the provisioning token secret is returned — once, to
      // the PC being paired.
      return c.json({
        provisioningToken: secret,
        tenantId: row.tenantId,
        branchId: row.branchId,
      });
    })

    // POST /auth — unauthenticated; this IS the credential-issuing step.
    // Cross-tenant lookup via withAdmin against EITHER
    // ChronoDeviceProvisioningTokens.tokenHash (fresh pairing) OR
    // ChronoDevices.tokenHash (a device re-authenticating with its own
    // already-issued token) — see Open Question 1 + Pass 2's three branches.
    .post("/auth", zValidator("json", authDeviceSchema), async (c) => {
      const { provisioningToken, fingerprint, hostname } = c.req.valid("json");
      const presentedHash = hashApiKey(provisioningToken);

      const [provRow] = await withAdmin((tx) =>
        tx
          .select()
          .from(chronoDeviceProvisioningToken)
          .where(
            and(
              eq(chronoDeviceProvisioningToken.tokenHash, presentedHash),
              eq(chronoDeviceProvisioningToken.status, "active"),
              gte(chronoDeviceProvisioningToken.tokenExpiresAt, new Date()),
            ),
          )
          .limit(1),
      );
      const [ownDeviceRow] = provRow
        ? [undefined]
        : await withAdmin((tx) =>
            tx.select().from(chronoDevice).where(eq(chronoDevice.tokenHash, presentedHash)).limit(1),
          );

      if (!provRow && !ownDeviceRow) {
        throw new HttpError(401, "Invalid or expired provisioning token.");
      }

      if (provRow) {
        // Extra defense-in-depth on top of the exact-hash lookup above,
        // mirroring resolveApiKeyContext()'s constant-time verify step.
        if (!provRow.tokenHash || !verifyApiKey(provisioningToken, provRow.tokenHash)) {
          throw new HttpError(401, "Invalid or expired provisioning token.");
        }
        if (provRow.maxUses != null && provRow.useCount >= provRow.maxUses) {
          throw new HttpError(401, "Invalid or expired provisioning token.");
        }

        const result = await withTenant(provRow.tenantId, async (tx) => {
          const [existing] = await tx
            .select()
            .from(chronoDevice)
            .where(
              and(
                eq(chronoDevice.tenantId, provRow.tenantId),
                eq(chronoDevice.deviceFingerprint, fingerprint),
              ),
            )
            .limit(1);

          const { secret, hash } = mintCredential();

          await tx
            .update(chronoDeviceProvisioningToken)
            .set({ useCount: provRow.useCount + 1, updatedAt: new Date() })
            .where(eq(chronoDeviceProvisioningToken.id, provRow.id));

          if (!existing) {
            // New fingerprint + valid provisioning token -> insert a fresh
            // pending_approval device row.
            const [created] = await tx
              .insert(chronoDevice)
              .values({
                id: createId(),
                tenantId: provRow.tenantId,
                branchId: provRow.branchId,
                deviceFingerprint: fingerprint,
                tokenHash: hash,
                status: "pending_approval",
                hostname,
              })
              .returning();
            return { deviceToken: secret, status: created?.status, minted: true };
          }

          // Known fingerprint, but the credential presented was a
          // provisioning token rather than this device's own already-issued
          // token -> re-pairing / cloned-image case. Never trust the
          // fingerprint match alone: reset to pending_approval and rotate
          // the device's own token.
          const [updated] = await tx
            .update(chronoDevice)
            .set({
              tokenHash: hash,
              status: "pending_approval",
              hostname: hostname ?? existing.hostname,
              updatedAt: new Date(),
            })
            .where(eq(chronoDevice.id, existing.id))
            .returning();
          return { deviceToken: secret, status: updated?.status, minted: true };
        });

        return c.json(result, 201);
      }

      // ownDeviceRow: the device is re-authenticating with its own
      // already-issued token.
      const device = ownDeviceRow!;
      if (!verifyApiKey(provisioningToken, device.tokenHash)) {
        throw new HttpError(401, "Invalid or expired provisioning token.");
      }

      if (device.deviceFingerprint === fingerprint) {
        // Known fingerprint + known tokenHash -> idempotent re-auth. Return
        // current status, mint nothing new.
        return c.json({ status: device.status, minted: false });
      }

      // Same secret token presented from a DIFFERENT fingerprint than the
      // one on file. This is the acute form of "never trust a fingerprint
      // match alone" — the plan's three branches don't literally enumerate
      // this case (it only arises via the device's OWN token, which a
      // legitimate client never presents from a second machine), so this
      // deliberately fails closed (401) rather than rotating credentials or
      // widening approval state for a request that looks like credential
      // theft/cloning.
      throw new HttpError(401, "Invalid or expired provisioning token.");
    })

    // POST /heartbeat — device-bearer-protected.
    .post(
      "/heartbeat",
      requireDeviceBearerAuth(),
      zValidator("json", heartbeatSchema),
      async (c) => {
        const device = c.var.device;
        const input = c.req.valid("json");
        const now = new Date();

        await withTenant(device.tenantId, (tx) =>
          tx
            .update(chronoDevice)
            .set({
              lastSeenAt: now,
              connectivityStatus: "online",
              clientVersion: input.clientVersion,
              osVersion: input.osVersion,
              metadata: {
                lockState: input.lockState,
                runtimeStatus: input.runtimeStatus,
                uptimeSeconds: input.uptimeSeconds,
              },
              updatedAt: now,
            })
            .where(and(eq(chronoDevice.id, device.deviceId), eq(chronoDevice.tenantId, device.tenantId))),
        );

        // Minimal, honest response — no session/pricing/reservation payload
        // (that's `sessions`' concern once it exists).
        return c.json({ status: "ok", timestamp: now.toISOString() });
      },
    )

    // POST /security-alert — device-bearer-protected (security-alerts Phase 5).
    // branchId/stationId/deviceId are never taken from the client — derived
    // solely from the authenticated device's own row, exactly like heartbeat
    // above never trusts a client-supplied deviceId/tenantId.
    .post(
      "/security-alert",
      requireDeviceBearerAuth(),
      zValidator("json", deviceReportSecurityAlertSchema),
      async (c) => {
        const device = c.var.device;
        const input = c.req.valid("json");

        const retryAfter = await deviceSecurityAlertLimiter.blockedFor(device.deviceId);
        if (retryAfter !== null) {
          return c.json(
            { error: "Too many alerts reported by this device. Try again later." },
            429,
            { "Retry-After": String(retryAfter) },
          );
        }

        const [created] = await withTenant(device.tenantId, (tx) =>
          tx
            .insert(chronoSecurityAlert)
            .values({
              tenantId: device.tenantId,
              branchId: device.branchId,
              stationId: device.stationId,
              deviceId: device.deviceId,
              raisedBy: "device",
              severity: input.severity,
              type: input.type,
              message: input.message,
              metadata: input.metadata ?? null,
            })
            .returning({ id: chronoSecurityAlert.id }),
        );

        await deviceSecurityAlertLimiter.record(device.deviceId);

        // 201, no human-facing payload needed — mirrors the plan's own
        // "no UI feedback (no human in the loop)" acceptance criterion.
        return c.json({ id: created?.id, status: "recorded" as const }, 201);
      },
    );
}
