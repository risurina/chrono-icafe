import { registerAppPermissions } from "agora/auth/permissions";

/**
 * Chrono's own permission vocabulary. Registered with the foundation via
 * `registerAppPermissions()` (see `../auth-bootstrap.ts`) rather than added
 * directly to `packages/agora/src/auth/permissions.ts` — business-app-
 * specific resources live in the owning app. See `.ai/rules/business-app.md`.
 */
export const CHRONO_PERMISSION_STATEMENTS = {
  // No staff-level branch mutation exists (read is ungated), so `branch` is
  // deliberately absent from CHRONO_STAFF_GRANTS below.
  branch: ["create", "update"],
  // Staff gets day-to-day floor management (create/update stations and
  // station groups); delete is admin+ only, matching the `file` resource
  // precedent. See .ai/plans/chrono/active/stations/HANDOVER.md.
  station: ["create", "update", "delete"],
  // Any staff/admin/owner may open or close a shift — not owner-restricted,
  // matches oikos. See .ai/plans/chrono/active/shifts/HANDOVER.md.
  shift: ["open", "close"],
  // Booking/check-in/cancel/no-show is routine front-desk work, not a
  // financial or configuration action — no staff/admin split (Open Question
  // 7). See .ai/plans/chrono/active/reservations/README.md.
  reservation: ["read", "manage"],
  // Device pairing/approval/revocation is a hardware-trust decision (closer
  // in risk profile to `domain`/`branding`/`integration` than to `station`'s
  // day-to-day floor reconfiguration) — admin+ only, no staff grant. GET
  // stays ungated so staff retain read visibility. See Open Question 2 in
  // .ai/plans/chrono/active/devices/README.md.
  device: ["approve", "revoke", "manage"],
  // Wallet mutations are a financial action, a materially different risk
  // profile from identity CRUD — a wholly new resource, not an extension of
  // `customer`. Staff holds day-to-day counter operations (credit/debit,
  // matching oikos's own STAFF-inclusive top-up/debit gate); `adjust`
  // (the correction/reversal path) sits at admin+. See Open Question 1 in
  // .ai/plans/chrono/active/wallet/README.md.
  wallet: ["read", "credit", "debit", "adjust"],
  // The counter operation (read/sell) is routine, staff-level work — matches
  // wallet's own precedent of granting staff the day-to-day money-moving
  // action. Catalog management and refunds are corrections/config, gated
  // stricter at admin+. See Open Question 1 in
  // .ai/plans/chrono/active/pos/README.md.
  pos: ["read", "sell", "void", "manageProducts"],
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  station: ["create", "update"],
  shift: ["open", "close"],
  reservation: ["read", "manage"],
  wallet: ["read", "credit", "debit"],
  pos: ["read", "sell"],
} satisfies Record<string, string[]>;

export const CHRONO_ADMIN_GRANTS = {
  branch: ["create", "update"],
  station: ["create", "update", "delete"],
  shift: ["open", "close"],
  reservation: ["read", "manage"],
  device: ["approve", "revoke", "manage"],
  wallet: ["read", "credit", "debit", "adjust"],
  pos: ["read", "sell", "void", "manageProducts"],
} satisfies Record<string, string[]>;

/** Called once, from `../auth-bootstrap.ts`, before anything imports `agora/auth`. */
export function registerChronoPermissions(): void {
  registerAppPermissions(CHRONO_PERMISSION_STATEMENTS, {
    staff: CHRONO_STAFF_GRANTS,
    admin: CHRONO_ADMIN_GRANTS,
  });
}
