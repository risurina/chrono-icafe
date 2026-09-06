"use client";

import { useState } from "react";
import { Button, CenteredMessage, Card, CardHeader, CardTitle, CardDescription, CardContent, toast } from "agora/ui";
import { applyForTenantMembership } from "@/lib/customer-client";
import { track } from "@/lib/analytics";

/**
 * Shown instead of redirecting to /login when a signed-in GLOBAL customer
 * (agora/customer-auth) has not yet applied to become a member of this
 * tenant. Copy is asserted verbatim by an existing e2e spec — do not reword.
 * Moved here unchanged from the old `tenant-portal-layout.tsx`.
 */
export function ApplyForTenantPrompt() {
  const [applying, setApplying] = useState(false);

  async function onApply() {
    setApplying(true);
    const { error } = await applyForTenantMembership();
    if (error) {
      toast.error(error);
      setApplying(false);
      return;
    }
    track("PLAYER_SIGNUP_FROM_TENANT", { method: "customer_apply" });
    location.reload();
  }

  return (
    <CenteredMessage>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Join this business</CardTitle>
          <CardDescription>
            You&apos;re signed in with your account — apply to become a customer
            of this business to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onApply} disabled={applying} className="w-full">
            {applying ? "Applying…" : "Apply"}
          </Button>
        </CardContent>
      </Card>
    </CenteredMessage>
  );
}
