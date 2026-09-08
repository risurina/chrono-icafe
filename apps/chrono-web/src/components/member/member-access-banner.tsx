"use client";

import { Row } from "agora/ui";
import { NeedHelpLinks } from "./need-help-links";

/**
 * Slim, full-width bar shown above `<RouteGate>` in `Chrome` (`member-gate.tsx`)
 * for a pending member — replaces the old full-page `ApprovalRequiredCard`
 * takeover so the page shell behind it stays visible. The guest (not-yet-applied)
 * variant was removed; a first-time visitor is now silently registered as a
 * `"visitor"` instead (`member-gate.tsx`), whose Apply CTA lives inline next to
 * each locked control (`unlock-hint.tsx`) rather than a top banner.
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
