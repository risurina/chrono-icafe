import { createHash } from "node:crypto";
import { Hono } from "hono";
import { withAdmin, eq } from "agora/db";
import { HttpError, createRateLimiter, clientIp } from "agora/server";
import { createId } from "agora";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import * as base from "agora/db/schema";
import { chronoStation } from "../station/schema";
import { chronoBranch } from "../branch/schema";
import { chronoQrTokenUse } from "./schema";
import { verifyStationQrToken } from "./token";
import {
  resolveQrSchema,
  consumeQrSchema,
  QR_TOKEN_TTL_SECONDS,
  type QrResolveResult,
  type QrConsumeResult,
} from "./contracts";

/**
 * True if `err` is a Postgres unique-violation (SQLSTATE 23505). Drizzle
 * wraps the raw `pg` error in a `DrizzleQueryError` whose own `.cause`
 * carries the actual `code`, so both shapes are checked.
 */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (v: unknown): v is { code: string } =>
    typeof v === "object" && v !== null && "code" in v && (v as { code: unknown }).code === "23505";
  if (hasCode(err)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return hasCode(cause);
}

/**
 * Single generic message for EVERY resolve/consume-verification failure —
 * malformed, tampered signature, expired, version-mismatched, or a station
 * that no longer exists. Never distinguishes which check failed, matching
 * the `devices` `/auth` precedent (qr plan Pass 1 "Failure cases" +
 * Divergence 1).
 */
const GENERIC_QR_ERROR = "Invalid or expired code.";

/**
 * `qr-{stationId}-{version}-{timestamp}-{nonce}:{signature}` — extracts only
 * the `stationId` segment, purely as a DB lookup key (and a rate-limit
 * bucket key) — never trusted as tenant-scoping input by itself. Malformed
 * input safely yields `null`; the real validation happens in
 * `verifyStationQrToken` once the station's own secret is loaded.
 */
function extractStationIdForLookup(token: string): string | null {
  const body = token.split(":")[0];
  if (!body) return null;
  const parts = body.split("-");
  if (parts.length !== 5 || parts[0] !== "qr") return null;
  return parts[1] ?? null;
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function tenantHostFor(slug: string): string {
  const appDomain = process.env.APP_DOMAIN ?? "localtest.me:3000";
  return `${slug}.${appDomain}`;
}

type ResolvedStation = {
  tenantId: string;
  tenantSlug: string;
  stationId: string;
  stationName: string;
  branchName: string;
  qrSecret: string | null;
  qrSecretVersion: number;
};

async function loadStationForQr(stationId: string): Promise<ResolvedStation | null> {
  const [row] = await withAdmin((tx) =>
    tx
      .select({
        tenantId: chronoStation.tenantId,
        tenantSlug: base.organization.slug,
        stationId: chronoStation.id,
        stationName: chronoStation.name,
        branchName: chronoBranch.name,
        qrSecret: chronoStation.qrSecret,
        qrSecretVersion: chronoStation.qrSecretVersion,
      })
      .from(chronoStation)
      .innerJoin(base.organization, eq(chronoStation.tenantId, base.organization.id))
      .innerJoin(chronoBranch, eq(chronoStation.branchId, chronoBranch.id))
      .where(eq(chronoStation.id, stationId))
      .limit(1),
  );
  return row ?? null;
}

// Read-only and replayable within its TTL (a customer may re-scan or the
// landing page may re-fetch) — kept lenient, but still bounded per-IP AND
// per-station so one screen can't be brute-forced. Same order of magnitude
// as the device pairing limiters (10/15min ip, 5/15min secret,
// apps/chrono-api/src/app.ts) but a shorter window / higher ceiling: a
// station's own QR is legitimately re-scanned by many different phones in
// quick succession, unlike a single device's own pairing code.
const qrResolveIpLimiter = createRateLimiter(30, 60 * 1000, "qr-resolve-ip"); // 30 / minute / IP
const qrResolveStationLimiter = createRateLimiter(60, 60 * 1000, "qr-resolve-station"); // 60 / minute / station

/**
 * Chrono's first genuinely public, pre-tenant-context surface — mounted
 * directly on `app` (`/public/qr/*`), outside `/rpc` and outside
 * `tenantMiddleware()`. See `apps/chrono-api/AGENTS.md`'s "Unauthenticated
 * routes" convention and the qr plan Pass 2 "Routes" section.
 */
export function qrPublicRoutes() {
  return (
    new Hono<{ Variables: MemberVars }>()
      // GET /resolve — no session, no tenant context. Resolves purely off the
      // signed token; the station row (looked up by id via withAdmin, never
      // c.var.tenant) is what tells us which tenant it belongs to.
      //
      // Deliberately NOT `zValidator("query", resolveQrSchema)` here: the
      // shared `zValidator` reports the Zod issue message verbatim, which
      // would make a malformed token 400 with a DIFFERENT body
      // ("Invalid QR code format") than every other failure mode's generic
      // message — exactly the distinguishing leak Divergence 1/7 rules out.
      // Parsed by hand instead, folded into the same generic error path.
      .get("/resolve", async (c) => {
        const parsed = resolveQrSchema.safeParse({ token: c.req.query("token") });
        if (!parsed.success) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }
        const { token } = parsed.data;

        const ip = clientIp(c);
        const ipRetryAfter = await qrResolveIpLimiter.blockedFor(ip);
        if (ipRetryAfter !== null) {
          return c.json({ error: "Too many attempts. Try again later." }, 429, {
            "Retry-After": String(ipRetryAfter),
          });
        }

        const stationId = extractStationIdForLookup(token);
        if (stationId) {
          const stationRetryAfter = await qrResolveStationLimiter.blockedFor(stationId);
          if (stationRetryAfter !== null) {
            return c.json({ error: "Too many attempts. Try again later." }, 429, {
              "Retry-After": String(stationRetryAfter),
            });
          }
        }

        await qrResolveIpLimiter.record(ip);
        if (stationId) await qrResolveStationLimiter.record(stationId);

        if (!stationId) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }
        const station = await loadStationForQr(stationId);
        if (!station || !station.qrSecret) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }

        const verified = verifyStationQrToken(token, {
          id: station.stationId,
          qrSecret: station.qrSecret,
          qrSecretVersion: station.qrSecretVersion,
        });
        if (!verified.ok) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }

        const result: QrResolveResult = {
          tenantSlug: station.tenantSlug,
          tenantHost: tenantHostFor(station.tenantSlug),
          stationId: station.stationId,
          stationName: station.stationName,
          branchName: station.branchName,
          // Phase 3 does not attempt session detection here (Phase 4's web
          // landing page owns that) — a client always treats a resolved scan
          // as requiring its own session check.
          requiresLogin: true,
        };
        return c.json(result);
      })
      // POST /consume — requires an authenticated tenantMember (portal)
      // session, reusing the foundation's own `memberMiddleware()` — NOT
      // staff `tenantMiddleware()`. The request must be made against the
      // resolved tenant's own host (x-tenant-slug/x-tenant-host), same as
      // every other `/portal/*` foundation route.
      // Same hand-parsed-schema reasoning as `/resolve` above — a malformed
      // body must fail with the identical generic message, not `zValidator`'s
      // own distinct Zod-issue text.
      .post("/consume", memberMiddleware(), async (c) => {
        const { tenantId, memberId } = c.var.member;
        const parsed = consumeQrSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }
        const { token } = parsed.data;

        const stationId = extractStationIdForLookup(token);
        if (!stationId) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }
        const station = await loadStationForQr(stationId);
        // The token must belong to a station in the CALLER's own tenant —
        // never trust the token's tenant implicitly for the mutating path.
        if (!station || !station.qrSecret || station.tenantId !== tenantId) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }

        const verified = verifyStationQrToken(token, {
          id: station.stationId,
          qrSecret: station.qrSecret,
          qrSecretVersion: station.qrSecretVersion,
        });
        if (!verified.ok) {
          throw new HttpError(400, GENERIC_QR_ERROR);
        }

        const nonceHash = hashNonce(verified.nonce);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + QR_TOKEN_TTL_SECONDS * 1000);

        try {
          await withAdmin((tx) =>
            tx.insert(chronoQrTokenUse).values({
              id: createId(),
              tenantId,
              stationId: station.stationId,
              nonceHash,
              consumedByMemberId: memberId,
              consumedAt: now,
              expiresAt,
            }),
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "This code has already been used.");
          }
          throw err;
        }

        // Stub until `sessions` Phase 5 wires the real start-session call
        // (qr plan "Dependency decision") — intentionally final for this
        // phase, not a placeholder left half-done.
        const result: QrConsumeResult = { resolved: true, sessionStartAvailable: false };
        return c.json(result);
      })
  );
}
