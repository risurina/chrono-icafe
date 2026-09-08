"use client";

import { Row } from "agora/ui";
import { NeedHelpLinks } from "./need-help-links";

/**
 * Slim, full-width bar shown above `<RouteGate>` in `Chrome` (`member-gate.tsx`)
 * for a pending member — replaces the old full-page `ApprovalRequiredCard`
 * takeover so the page shell behind it stays visible. The guest (not-yet-applied)
 * variant was removed; that state's Apply CTA now lives in `RequiresMembership`'s
 * per-section locked card instead of a top banner.
 */
export function MemberAccessBanner() {
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
