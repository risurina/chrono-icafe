"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "agora/ui";
import { useGlobalCustomerSession } from "@/lib/customer-client";

/**
 * Global customer profile page — the "Your account" identity card, moved out
 * of the `/member` dashboard (`global-portal-home.tsx`) into its own route.
 */
export function GlobalPortalProfile() {
  const { customer } = useGlobalCustomerSession();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
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
