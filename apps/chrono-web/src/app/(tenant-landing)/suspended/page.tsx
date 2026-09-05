"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  AuthLayout,
} from "agora/ui";

/**
 * Shown when a tenant business is suspended. Non-owner staff and customers are
 * redirected here by the dashboard/portal when the API reports the business as
 * suspended (see the WORKSPACE_SUSPENDED marker). Data is retained — an owner
 * can resume the business from the Danger Zone.
 */
export default function SuspendedPage() {
  return (
    <AuthLayout inset>
      <Card>
        <CardHeader>
          <CardTitle>Business suspended</CardTitle>
          <CardDescription>
            Access to this business is currently suspended.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Your data is safe and retained. The business owner can resume access at any
            time from the business settings.
          </p>
          <p>If you believe this is a mistake, contact the business owner.</p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
