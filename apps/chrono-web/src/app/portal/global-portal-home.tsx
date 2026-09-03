"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "agora/ui";
import { useGlobalCustomerSession } from "@/lib/customer-client";

/**
 * Global customer account home. To become a customer of a specific
 * business, visit that business's `/portal` while signed in here — it
 * offers a one-click "Apply" (see apps/chrono-web/src/app/portal/tenant-portal-layout.tsx).
 */
export function GlobalPortalHome() {
  const { customer } = useGlobalCustomerSession();

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
    </div>
  );
}
