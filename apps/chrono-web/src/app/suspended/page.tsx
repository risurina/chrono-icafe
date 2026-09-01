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
 * Shown when a tenant workspace is suspended. Non-owner staff and customers are
 * redirected here by the dashboard/portal when the API reports the workspace as
 * suspended (see the WORKSPACE_SUSPENDED marker). Data is retained — an owner
 * can resume the workspace from the Danger Zone.
 */
export default function SuspendedPage() {
  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Workspace suspended</CardTitle>
          <CardDescription>
            Access to this workspace is currently suspended.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Your data is safe and retained. The workspace owner can resume access at any
            time from the workspace settings.
          </p>
          <p>If you believe this is a mistake, contact the workspace owner.</p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
