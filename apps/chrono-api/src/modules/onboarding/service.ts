import { withTenant, eq, and } from "agora/db";
import { onboardingChecklistStateSchema, type OnboardingChecklistState } from "agora";
import { hasPermission } from "../../auth/require-permission";
import { CHRONO_ONBOARDING_ITEMS } from "./contracts";
import { tenantOnboardingDismissal } from "agora/db/schema";

/**
 * The single, deliberate implementation of "what does this tenant's
 * onboarding checklist look like right now?" — every route in this plan and
 * in `onboarding-wizard` is a thin caller of this function. Do not inline
 * probe queries into a route handler; that is exactly the drift this
 * function exists to prevent.
 *
 * Reads the per-viewer dismissal row FIRST and returns early, before running
 * any of the seven completion probes, when dismissed — a dashboard load for
 * a tenant that dismissed the card long ago must cost one query, not eight.
 */
export async function resolveOnboardingState(
  tenantId: string,
  userId: string,
  permissions: Record<string, string[]>,
): Promise<OnboardingChecklistState> {
  const dismissed = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: tenantOnboardingDismissal.id })
      .from(tenantOnboardingDismissal)
      .where(
        and(
          eq(tenantOnboardingDismissal.tenantId, tenantId),
          eq(tenantOnboardingDismissal.userId, userId),
        ),
      )
      .limit(1),
  );

  if (dismissed.length > 0) {
    return onboardingChecklistStateSchema.parse({
      items: [],
      completedCount: 0,
      total: 0,
      allDone: false,
      dismissed: true,
    });
  }

  const entries = Object.entries(CHRONO_ONBOARDING_ITEMS);

  const items = await withTenant(tenantId, async (tx) => {
    return Promise.all(
      entries.map(async ([key, item]) => ({
        key,
        label: item.label,
        description: item.description,
        href: item.href,
        stage: item.stage,
        done: await item.probe(tx, tenantId),
        actionable: item.requiredPermission
          ? hasPermission(permissions, item.requiredPermission)
          : true,
        wizardStep: item.wizardStep,
      })),
    );
  });

  const completedCount = items.filter((i) => i.done).length;
  const total = items.length;

  return onboardingChecklistStateSchema.parse({
    items,
    completedCount,
    total,
    allDone: total > 0 && completedCount === total,
    dismissed: false,
  });
}
