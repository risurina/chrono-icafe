import Link from "next/link";
import { Row } from "agora/ui";
import { apexUrl } from "@/lib/app-domain";

/**
 * The member portal's single "Need help?" affordance (member-portal-v2 phase
 * 9) — distinguishes a venue-operational issue from an account/platform-level
 * one, both of which previously collapsed into one "Contact the business"
 * link even for issues the venue can't act on (e.g. a rejected application,
 * a platform outage).
 *
 * - **Contact administrator** — unchanged existing pattern: the tenant's own
 *   staff-facing inquiry queue (`/member/inquiries`, already in `MEMBER_NAV`
 *   as the "Help" menu entry).
 * - **Contact Chrono support** — new: the apex `/company/contact` form, the
 *   same IZUR-the-vendor lead/support form already wired to
 *   `POST /public/company-inquiries` (emailed to `SUPPORT_INBOX_EMAIL`).
 *   Reached via `apexUrl()` (`@/lib/app-domain`), the existing helper for
 *   every other cross-host link in this app (`post-auth.ts`, `tenant.ts`) —
 *   `/company/contact` is an apex-only marketing page, so a bare `Link`
 *   would resolve on the current tenant subdomain instead. Opens in a new
 *   tab so a member doesn't lose their place in the portal.
 *
 * One component, used from `member-gate.tsx`'s `MemberAccessBanner` (pending
 * variant), `member/page.tsx`'s membership-status card, and
 * `member/settings/page.tsx`'s Account card, so all three read and behave
 * identically.
 */
export function NeedHelpLinks({ className }: { className?: string }) {
  return (
    <Row gap={4} wrap className={className}>
      <Link href="/member/inquiries" className="text-sm underline underline-offset-2">
        Contact administrator
      </Link>
      <Link
        href={apexUrl("/company/contact")}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm underline underline-offset-2"
      >
        Contact Chrono support
      </Link>
    </Row>
  );
}
