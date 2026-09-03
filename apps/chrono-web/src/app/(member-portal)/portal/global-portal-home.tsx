"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
} from "agora/ui";
import {
  useGlobalCustomerSession,
  getMyTenantMemberships,
  type GlobalCustomerMembership,
} from "@/lib/customer-client";

function tenantPortalUrl(slug: string): string {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";
  const scheme = typeof window !== "undefined" ? window.location.protocol : "https:";
  return `${scheme}//${slug}.${appDomain}/portal`;
}

/** Active tenant lifecycle states — everything else blocks portal access
 * (`assertTenantActive`), so it renders as a badge instead of a live link. */
const REACHABLE_STATUSES = new Set(["active", "trial", "pending"]);

function MembershipRow({ membership }: { membership: GlobalCustomerMembership }) {
  const reachable = REACHABLE_STATUSES.has(membership.tenantStatus);
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm font-medium">{membership.tenantName}</span>
      {reachable ? (
        <a
          href={tenantPortalUrl(membership.tenantSlug)}
          className="text-sm text-primary hover:underline"
        >
          Go to portal →
        </a>
      ) : (
        <Badge variant="secondary">{membership.tenantStatus}</Badge>
      )}
    </div>
  );
}

/**
 * Global customer account home. To become a customer of a specific
 * business, visit that business's `/portal` while signed in here — it
 * offers a one-click "Apply" (see apps/chrono-web/src/app/portal/tenant-portal-layout.tsx).
 */
export function GlobalPortalHome() {
  const { customer } = useGlobalCustomerSession();
  const [memberships, setMemberships] = useState<GlobalCustomerMembership[] | null>(null);

  useEffect(() => {
    let active = true;
    getMyTenantMemberships().then(({ data }) => {
      if (active) setMemberships(data ?? []);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{customer ? `, ${customer.name}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          One account, usable across every business you join.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>This identity is shared across every business.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{customer?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{customer?.email ?? "—"}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your businesses</CardTitle>
          <CardDescription>
            Businesses you&apos;ve applied to and been approved for.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {memberships === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : memberships.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven&apos;t joined any businesses yet — visit a business&apos;s
              portal and apply to become a customer there.
            </p>
          ) : (
            <div className="divide-y">
              {memberships.map((m) => (
                <MembershipRow key={m.tenantSlug} membership={m} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
