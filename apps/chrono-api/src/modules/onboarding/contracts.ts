import type { TenantTx } from "agora/db";
import { eq, and, count } from "agora/db";
import { adminDb, schema as base } from "agora/db";
import type { OnboardingChecklistItem } from "agora";
import { chronoBranch } from "../branch/schema";
import { chronoStationGroup, chronoStation } from "../station/schema";
import { chronoProduct } from "../pos/schema";
import { chronoDeviceProvisioningToken } from "../device/schema";
import { chronoShift } from "../shift/schema";

/**
 * A Chrono onboarding item, extending the foundation's `OnboardingChecklistItem`
 * with the completion probe the foundation type deliberately leaves out (it is
 * not serializable, so it can never be part of the Zod-shaped resolved state —
 * see `packages/agora/src/contracts/onboarding.ts`'s own doc comment).
 */
export type ChronoOnboardingItem = OnboardingChecklistItem & {
  /** Runs INSIDE the caller's own withTenant/adminDb transaction. */
  probe: (tx: TenantTx, tenantId: string) => Promise<boolean>;
};

async function exists<T>(rows: Promise<T[]>): Promise<boolean> {
  return (await rows).length > 0;
}

/**
 * Seven steps across three stages — verified against the real routes and
 * permission grants in `apps/chrono-api/src/auth/permissions.ts` (see
 * `.ai/plans/chrono/active/onboarding-checklist/README.md`, "The item set").
 */
export const CHRONO_ONBOARDING_ITEMS = {
  createBranch: {
    label: "Create your first branch",
    description: "Add the venue location your stations and staff belong to.",
    href: "/branches",
    stage: "Venue",
    requiredPermission: { branch: ["create"] },
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoBranch.id })
          .from(chronoBranch)
          .where(eq(chronoBranch.tenantId, tenantId))
          .limit(1),
      ),
  },
  addStationGroup: {
    label: "Add a station group",
    description: "Group your stations by rate or type before adding them.",
    href: "/stations",
    stage: "Venue",
    requiredPermission: { station: ["create"] },
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoStationGroup.id })
          .from(chronoStationGroup)
          .where(eq(chronoStationGroup.tenantId, tenantId))
          .limit(1),
      ),
  },
  addStation: {
    label: "Add a station",
    description: "Add the first PC or seat customers will book or walk up to.",
    href: "/stations",
    stage: "Venue",
    requiredPermission: { station: ["create"] },
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoStation.id })
          .from(chronoStation)
          .where(eq(chronoStation.tenantId, tenantId))
          .limit(1),
      ),
  },
  inviteStaff: {
    label: "Invite a staff member",
    description: "Bring a teammate onto the workspace.",
    href: "/settings/members",
    stage: "Team",
    requiredPermission: { staff: ["invite"] },
    // Foundation org tables (member, invitation) are NOT RLS-scoped — filtered
    // explicitly by organizationId via adminDb, never withTenant. A `member`
    // row appears only once an invite is ACCEPTED, so counting members alone
    // would leave an owner who just invited their whole team stuck on red;
    // a still-pending invitation counts too.
    probe: async (_tx, tenantId) => {
      const [memberCount] = await adminDb
        .select({ n: count() })
        .from(base.member)
        .where(eq(base.member.organizationId, tenantId));
      if ((memberCount?.n ?? 0) > 1) return true;
      return exists(
        adminDb
          .select({ id: base.invitation.id })
          .from(base.invitation)
          .where(
            and(
              eq(base.invitation.organizationId, tenantId),
              eq(base.invitation.status, "pending"),
            ),
          )
          .limit(1),
      );
    },
  },
  addProducts: {
    label: "Add POS products",
    description: "List the snacks, drinks, or extras you sell at the counter.",
    href: "/pos/products",
    stage: "Trading",
    requiredPermission: { pos: ["manageProducts"] },
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoProduct.id })
          .from(chronoProduct)
          .where(eq(chronoProduct.tenantId, tenantId))
          .limit(1),
      ),
  },
  pairDevice: {
    label: "Create a device pairing code",
    description: "Generate a code so a kiosk PC can pair with this workspace.",
    href: "/devices",
    stage: "Trading",
    requiredPermission: { device: ["manage"] },
    // Deliberately probes chronoDeviceProvisioningToken, not chronoDevice: a
    // chronoDevice row is inserted only by real hardware presenting a pairing
    // code at the unauthenticated POST /pair — nothing a dashboard admin does
    // creates one. The only action a human can take is minting the token.
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoDeviceProvisioningToken.id })
          .from(chronoDeviceProvisioningToken)
          .where(eq(chronoDeviceProvisioningToken.tenantId, tenantId))
          .limit(1),
      ),
  },
  openShift: {
    label: "Open your first shift",
    description: "Start a cash-drawer shift so staff can begin serving customers.",
    href: "/shifts",
    stage: "Trading",
    requiredPermission: { shift: ["open"] },
    probe: (tx, tenantId) =>
      exists(
        tx
          .select({ id: chronoShift.id })
          .from(chronoShift)
          .where(eq(chronoShift.tenantId, tenantId))
          .limit(1),
      ),
  },
} as const satisfies Record<string, ChronoOnboardingItem>;
