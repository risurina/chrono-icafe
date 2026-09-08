"use client";

import { Lock } from "lucide-react";
import { Button, Row } from "agora/ui";
import { useApplyForTenant } from "./apply-for-tenant-prompt";

/**
 * member-visitor-status-tier: inline affordance rendered next to a disabled
 * mutating control for a `"visitor"` (real read access, no application yet —
 * see `useMemberArea().canInteract`). Callers gate the control's own
 * `disabled` prop on `!canInteract` directly (composing with whatever other
 * disabled logic it already has) and render this alongside it — it does not
 * wrap/clone the control itself, since the controls it sits next to vary too
 * much (a bare `Button`, a form's submit `Button`, one per row in a list) for
 * a single wrapper shape to fit all of them cleanly.
 *
 * Reuses `useApplyForTenant()` unchanged: by the time a visitor sees this,
 * their `tenantMember` already exists, so `applyForTenantMembership()` is a
 * no-op with no error, and it's `POST /portal/members/apply`'s promote-
 * `"visitor"` branch that actually unlocks them.
 */
export function UnlockHint({ label = "Apply to unlock" }: { label?: string }) {
  const { applying, apply } = useApplyForTenant();

  return (
    <Row items="center" gap={1} wrap>
      <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-xs text-muted-foreground">Visiting — apply to unlock this.</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={apply}
        disabled={applying}
      >
        {applying ? "Applying…" : label}
      </Button>
    </Row>
  );
}
