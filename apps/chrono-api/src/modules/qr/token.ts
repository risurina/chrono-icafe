/**
 * Per-station rotating-secret HMAC signing for `qr` scan tokens — see qr plan
 * Pass 2, "Token design" + Divergence 2. Deliberately diverges from oikos's
 * single, permanent, deployment-wide `deviceTokenSecret`: signing here is
 * keyed off each station's own `qrSecret`/`qrSecretVersion`, so a leaked code
 * is invalidated by regenerating one station, never a global secret rotation.
 *
 * Pure, DB-free functions — station state and "now" are always passed in so
 * these are unit-testable without a database (qr plan Phase 2 acceptance
 * criteria: valid round-trip, tampered signature, expired, version mismatch,
 * malformed format).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { QR_TOKEN_RE, QR_TOKEN_TTL_SECONDS } from "./contracts";

export interface QrSigningStation {
  id: string;
  qrSecret: string;
  qrSecretVersion: number;
}

export type QrTokenVerifyResult =
  | { ok: true; stationId: string; version: number; nonce: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "version_mismatch" };

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Mints `qr-{stationId}-{version}-{timestamp}-{nonce}:{signature}` for the
 * given station's current `qrSecret`/`qrSecretVersion`.
 */
export function mintStationQrToken(station: QrSigningStation, now: number = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString("hex");
  const payload = `${station.id}:${station.qrSecretVersion}:${timestamp}:${nonce}`;
  const signature = sign(station.qrSecret, payload);
  return `qr-${station.id}-${station.qrSecretVersion}-${timestamp}-${nonce}:${signature}`;
}

/**
 * Verifies a scanned token against the station it claims to belong to.
 * Callers must have already looked up `station` by the id parsed from the
 * token (never trusting it as tenant-scoping input by itself — qr plan Pass
 * 2, "Token design") and pass the SAME station's current secret/version in.
 *
 * Fails closed and uniformly: a version mismatch is treated exactly like an
 * invalid signature (no distinct "stale but authentic" message) so a caller
 * can never infer from the response alone whether the station id/format was
 * otherwise well-formed — see qr plan Pass 2, Divergence 1/Token design.
 */
export function verifyStationQrToken(
  token: string,
  station: QrSigningStation,
  now: number = Date.now(),
): QrTokenVerifyResult {
  if (!QR_TOKEN_RE.test(token)) {
    return { ok: false, reason: "malformed" };
  }

  const [body, signature] = token.split(":");
  if (!body || !signature) {
    return { ok: false, reason: "malformed" };
  }
  // body = "qr-{stationId}-{version}-{timestamp}-{nonce}"
  const parts = body.split("-");
  // parts: ["qr", stationId, version, timestamp, nonce]
  if (parts.length !== 5 || parts[0] !== "qr") {
    return { ok: false, reason: "malformed" };
  }
  const [, stationId, versionRaw, timestampRaw, nonce] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const version = Number.parseInt(versionRaw, 10);
  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(version) || !Number.isFinite(timestamp)) {
    return { ok: false, reason: "malformed" };
  }

  if (stationId !== station.id || version !== station.qrSecretVersion) {
    return { ok: false, reason: "version_mismatch" };
  }

  const payload = `${stationId}:${version}:${timestamp}:${nonce}`;
  const expectedSignature = sign(station.qrSecret, payload);
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  const signatureValid =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  if (!signatureValid) {
    return { ok: false, reason: "signature" };
  }

  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds - timestamp > QR_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, stationId, version, nonce };
}
