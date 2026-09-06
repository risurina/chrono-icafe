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
  // `closeAny` is a separate, admin+-only action (Phase 4,
  // .ai/plans/chrono/active/audit-remediation/README.md): closing a shift
  // you did not open — otherwise any staff member could close someone
  // else's open shift and misattribute a cash discrepancy to the wrong
  // cashier. Deliberately NOT granted to staff.
  shift: ["open", "close", "closeAny"],
  // Booking/check-in/cancel/no-show is routine front-desk work, not a
  // financial or configuration action — no staff/admin split (Open Question
  // 7). See .ai/plans/chrono/active/reservations/README.md. "managePolicy"
  // (reservations-queue-and-self-service plan) is a separate, admin+-only
  // action for the per-tenant/branch reservation policy config and ban
  // lift — a config/override decision, not routine front-desk work, same
  // tier as wallet:adjust / pos:manageProducts.
  reservation: ["read", "manage", "managePolicy"],
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
  // Manual earn/redeem is routine front-desk work, matching wallet's own
  // credit/debit staff tier. `adjust` (a raw, signed correction with no
  // earn/redeem semantics) is admin+-only, mirroring wallet:adjust's exact
  // reasoning. See .ai/plans/chrono/active/loyalty/README.md, "Permission
  // vocabulary".
  loyalty: ["read", "manage", "adjust"],
  // Selling/consuming a pre-purchased minutes lot is routine counter work,
  // matching wallet's own credit/debit staff tier. Granting free minutes
  // (a comp) and adjusting/voiding an existing lot are corrections, admin+
  // only — mirroring wallet's own adjust gate exactly. manageProducts
  // (catalog/pricing/policy config) sits at the same admin+ tier as
  // branches' own configuration resources. See Open Question 1 in
  // .ai/plans/chrono/active/credits/README.md.
  credit: ["read", "sell", "consume", "grant", "adjust", "manageProducts"],
  // Issuing a goodwill voucher and cancelling an unused one is routine
  // front-desk/customer-service work, the same tier reservation's `manage`
  // established — no staff/admin split in this pass. Redemption itself
  // needs no new permission; it rides on the checkout caller's own
  // `pos:sell` gate (Phase 4). See .ai/plans/chrono/active/vouchers/README.md,
  // "Permission vocabulary".
  voucher: ["read", "manage"],
  // A promo controls store-wide pricing/margin for every sale that matches
  // it, for as long as it runs — closer in blast radius to
  // wallet:adjust/pos:manageProducts (both admin+) than to a single
  // customer-facing booking or a one-off voucher. Staff gets read only; no
  // staff/admin split precedent applies here (deliberate admin+-only
  // `manage`). Redemption itself needs no new permission — it rides on the
  // checkout caller's own `pos:sell` gate (Phase 4). See
  // .ai/plans/chrono/active/promos/README.md, "Permission vocabulary".
  promo: ["read", "manage"],
  // No staff-denied action exists on session (start/pause/resume/extend/end
  // all mirror oikos's own ungated requireAuth) — a first for this codebase.
  // See Open Question 3 in .ai/plans/chrono/active/sessions/README.md.
  session: ["create", "update"],
  // Staff-facing venue-membership approval workflow over the foundation's
  // `customer` (tenant_member) identity — moved out of
  // packages/agora/src/auth/permissions.ts (Phase 5,
  // .ai/plans/chrono/active/audit-remediation/README.md), where it was
  // accidentally left as a Chrono-specific leftover from the
  // permission-extension-seam migration. `read` matches the removed
  // foundation staff `customer:["read"]` grant; `update`/`approve`/`reject`
  // match the removed foundation admin `customer` approve/reject + this
  // module's own update gate. See
  // apps/chrono-api/src/modules/member/routes.ts.
  // `invite` (admin+ only, like approve/reject) lets staff proactively bring
  // a customer in: mints a tenantMember invite (agora/member-auth) and
  // approves the ChronoMemberProfiles row on send. See
  // .ai/plans/chrono/active/customer-invite/README.md.
  memberProfile: ["read", "update", "approve", "reject", "invite"],
  // A read-only aggregation layer over existing sales/shift/wallet data — no
  // new domain, no mutation. Staff sees branch-scoped summaries only;
  // `readFinancial` (the tenant-wide unscoped rollup + wallet activity) is
  // admin+-only, since wallet has no branchId to fall back to for a staff
  // view. See .ai/plans/chrono/active/reports/README.md, "Permission
  // vocabulary".
  report: ["read", "readFinancial"],
  // Staff manually reports/acknowledges/resolves alerts (the device-reporting
  // path is a separate, device-bearer-gated surface, not this resource) — no
  // staff/admin split, matching reservation/loyalty's "routine front-desk
  // work" precedent. See .ai/plans/chrono/active/security-alerts/README.md.
  securityAlert: ["read", "manage"],
  // Public/portal submission needs no permission (unauthenticated or
  // customer-session, not staff) — this resource governs only the
  // staff-facing queue: list/reply/status-change. No staff/admin split,
  // matching security-alert's own precedent. See
  // .ai/plans/chrono/active/inquiries/README.md.
  inquiry: ["read", "manage"],
  // Editing the tenant's public marketing content is closer in blast radius
  // to `branch`'s own configuration resources (branch has no staff grant
  // either) than to routine front-desk work — admin+ only, single `manage`
  // action (no read/write split needed since the read side is the public
  // route, ungated). See .ai/plans/chrono/active/tenant-landing/README.md.
  landingPage: ["manage"],
  // A generic, pre-settlement counter payment — distinct from a wallet
  // credit/debit, which has no payment-method/counter-audit trail of its
  // own. `pay` is a separate action from `create`: creating a pending
  // payment and settling it (the step that actually moves money) are
  // different acts and must gate separately. `void`/`refund` are admin+,
  // mirroring pos:void / wallet:adjust's own tier. See
  // .ai/plans/chrono/active/payments/README.md, "Permission vocabulary".
  payment: ["read", "create", "pay", "void", "refund"],
  // A read-only aggregation layer over shift and wallet data — no mutation.
  // Both staff and admin get read; no split per Open Question 1 in
  // .ai/plans/chrono/active/reconciliation/README.md.
  reconciliation: ["read"],
  // Per-station app/game telemetry (live view + usage report). Read-only — no
  // `manage` action exists at all, since this module has no human-triggered
  // mutation (the only writes are device-ingested or sweep-driven). Gated on
  // `read`, matching securityAlert/report/reconciliation/inquiry's own
  // "reads are gated" precedent — NOT device GET's ungated one (device is the
  // outlier: a hardware-trust list with no read action defined at all). See
  // .ai/plans/chrono/in-progress/app-usage/README.md, "Permissions".
  appUsage: ["read"],
  // How many players asked for this business on the public /discover page
  // before it joined — aggregate acquisition-demand data, and the reason the
  // grant is admin+ ONLY (no staff entry below).
  //
  // The shape precedent is appUsage:read (a read-only Chrono resource), but
  // copying its staff+admin grant would leave no boundary at all, and the role
  // gate would then be asserting deny-by-default plumbing rather than a real
  // gate — which .ai/rules/rbac.md explicitly rejects. The SENSITIVITY
  // precedents are report:readFinancial / promo:manage / landingPage:manage,
  // all admin+: this is commercial/marketing intelligence in the same family as
  // landingPage (whose publish action is literally what lists the business in
  // the directory these leads come from), not front-desk operational data.
  // See .ai/plans/chrono/in-progress/two-sided-growth-loop/README.md,
  // assumption 9.
  growth: ["read"],
} satisfies Record<string, string[]>;

export const CHRONO_STAFF_GRANTS = {
  station: ["create", "update"],
  shift: ["open", "close"],
  reservation: ["read", "manage"],
  wallet: ["read", "credit", "debit"],
  pos: ["read", "sell"],
  loyalty: ["read", "manage"],
  credit: ["read", "sell", "consume"],
  voucher: ["read", "manage"],
  promo: ["read"],
  session: ["create", "update"],
  memberProfile: ["read"],
  report: ["read"],
  securityAlert: ["read", "manage"],
  inquiry: ["read", "manage"],
  payment: ["read", "create", "pay"],
  reconciliation: ["read"],
  appUsage: ["read"],
} satisfies Record<string, string[]>;

export const CHRONO_ADMIN_GRANTS = {
  landingPage: ["manage"],
  branch: ["create", "update"],
  station: ["create", "update", "delete"],
  shift: ["open", "close", "closeAny"],
  reservation: ["read", "manage", "managePolicy"],
  device: ["approve", "revoke", "manage"],
  wallet: ["read", "credit", "debit", "adjust"],
  pos: ["read", "sell", "void", "manageProducts"],
  loyalty: ["read", "manage", "adjust"],
  credit: ["read", "sell", "consume", "grant", "adjust", "manageProducts"],
  voucher: ["read", "manage"],
  promo: ["read", "manage"],
  session: ["create", "update"],
  memberProfile: ["read", "update", "approve", "reject", "invite"],
  report: ["read", "readFinancial"],
  securityAlert: ["read", "manage"],
  inquiry: ["read", "manage"],
  payment: ["read", "create", "pay", "void", "refund"],
  reconciliation: ["read"],
  appUsage: ["read"],
  growth: ["read"],
} satisfies Record<string, string[]>;

/** Called once, from `../auth-bootstrap.ts`, before anything imports `agora/auth`. */
export function registerChronoPermissions(): void {
  registerAppPermissions(CHRONO_PERMISSION_STATEMENTS, {
    staff: CHRONO_STAFF_GRANTS,
    admin: CHRONO_ADMIN_GRANTS,
  });
}
