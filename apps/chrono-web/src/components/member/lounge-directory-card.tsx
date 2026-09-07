"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Row,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { tenantHref } from "@/lib/tenant-links";
import type { MembershipVenueStatus } from "@/lib/customer-client";

/** Active tenant lifecycle states — everything else is filtered out of the
 * directory listing server-side, but this stays as a defensive belt-and-braces
 * check so a non-reachable status never renders a live CTA. */
const REACHABLE_STATUSES = new Set(["active", "trial", "pending"]);

/**
 * One tenant card in the "Gaming Lounge Directory" grid — name, "CHRONO
 * LOUNGE" eyebrow, membership-branching description/CTA. Links out via the
 * shared `tenantHref()` helper, same cross-subdomain pattern the `/discover`
 * result card and `global-portal-home`'s existing membership links already use.
 */
export function LoungeDirectoryCard({
  name,
  slug,
  status,
  isMember,
  venueStatus,
}: {
  name: string;
  slug: string;
  status: string;
  isMember: boolean;
  /** Live open/closed + availability for a joined tenant — omitted (or still
   * loading) for a tenant the customer hasn't joined. */
  venueStatus?: MembershipVenueStatus;
}) {
  const reachable = REACHABLE_STATUSES.has(status);

  return (
    <Card data-testid="lounge-directory-card">
      <CardHeader>
        <Row justify="between" items="start" gap={3}>
          <span className="text-[10px] font-black uppercase tracking-widest text-primary">
            Chrono Lounge
          </span>
          {isMember && venueStatus ? (
            <Badge variant={venueStatus.status === "open" ? "default" : "secondary"}>
              {venueStatus.status === "open" ? "Open" : "Closed"}
            </Badge>
          ) : null}
        </Row>
        <CardTitle>{name}</CardTitle>
        <CardDescription>
          {isMember
            ? venueStatus
              ? `${venueStatus.available}/${venueStatus.total} stations available now.`
              : "You're a member here — jump back into your session, wallet, and history."
            : "Apply to become a customer and get access to this lounge's portal."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {reachable ? (
          <a
            href={tenantHref(slug, "global_directory")}
            className={cn(buttonVariants(), "w-full")}
            data-testid="lounge-directory-card-cta"
          >
            {isMember ? "Enter Portal" : "Apply to Join"}
          </a>
        ) : (
          <Badge variant="secondary">{status}</Badge>
        )}
      </CardContent>
    </Card>
  );
}
