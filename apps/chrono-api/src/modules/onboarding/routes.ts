import { Hono } from "hono";
import { withTenant } from "agora/db";
import { createId } from "agora";
import { tenantOnboardingDismissal } from "agora/db/schema";
import { type TenantVars } from "agora/server";
import { resolveOnboardingState } from "./service";

/**
 * Thin callers only — no probe query lives here. `resolveOnboardingState`
 * (`./service.ts`) is the single implementation both routes here and
 * `onboarding-wizard`'s own route depend on.
 *
 * Neither route is `requirePermission`-gated: viewing your own tenant's
 * checklist and dismissing your own card are not privileged actions — see
 * `.ai/plans/chrono/active/onboarding-checklist/README.md`, "Permission
 * vocabulary — corrected" / "Dismissal is a tenant-wide write — resolved".
 */
export function onboardingRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    .get("/onboarding/checklist", async (c) => {
      const { tenantId, userId, permissions } = c.var.tenant;
      const state = await resolveOnboardingState(tenantId, userId, permissions);
      return c.json(state);
    })
    .post("/onboarding/checklist/dismiss", async (c) => {
      const { tenantId, userId, permissions } = c.var.tenant;
      await withTenant(tenantId, (tx) =>
        tx
          .insert(tenantOnboardingDismissal)
          .values({ id: createId(), tenantId, userId })
          .onConflictDoNothing({
            target: [tenantOnboardingDismissal.tenantId, tenantOnboardingDismissal.userId],
          }),
      );
      const state = await resolveOnboardingState(tenantId, userId, permissions);
      return c.json(state);
    });
}
