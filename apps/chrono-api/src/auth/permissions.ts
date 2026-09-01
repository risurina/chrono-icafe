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
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  station: ["create", "update"],
  shift: ["open", "close"],
  reservation: ["read", "manage"],
} satisfies Record<string, string[]>;

export const CHRONO_ADMIN_GRANTS = {
  branch: ["create", "update"],
  station: ["create", "update", "delete"],
  shift: ["open", "close"],
  reservation: ["read", "manage"],
} satisfies Record<string, string[]>;

/** Called once, from `../auth-bootstrap.ts`, before anything imports `agora/auth`. */
export function registerChronoPermissions(): void {
  registerAppPermissions(CHRONO_PERMISSION_STATEMENTS, {
    staff: CHRONO_STAFF_GRANTS,
    admin: CHRONO_ADMIN_GRANTS,
  });
}
