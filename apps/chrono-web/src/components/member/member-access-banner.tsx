"use client";

import { Button, Row } from "agora/ui";
import { NeedHelpLinks } from "./need-help-links";
import { useApplyForTenant } from "./apply-for-tenant-prompt";

/**
 * Slim, full-width bar shown above `<RouteGate>` in `Chrome` (`member-gate.tsx`)
 * for a guest (not-yet-applied) or pending member — replaces the old full-page
 * `ApplyForTenantPrompt`/`ApprovalRequiredCard` takeovers so the page shell
 * behind it stays visible.
 */
export function MemberAccessBanner({ variant }: { variant: "not-applied" | "pending" }) {
  const { applying, apply } = useApplyForTenant();

  if (variant === "not-applied") {
    return (
      <Row
        items="center"
        justify="between"
        gap={4}
        wrap
        className="w-full border-b bg-muted/50 px-4 py-2"
      >
        <span className="text-sm">
          Join this business — apply to become a customer to unlock your account.
        </span>
        <Button onClick={apply} disabled={applying} size="sm">
          {applying ? "Applying…" : "Apply"}
        </Button>
      </Row>
    );
  }

  return (
    <Row
      items="center"
      justify="between"
      gap={4}
      wrap
      className="w-full border-b bg-muted/50 px-4 py-2"
    >
      <span className="text-sm">Your membership application is pending approval.</span>
      <NeedHelpLinks />
    </Row>
  );
}
