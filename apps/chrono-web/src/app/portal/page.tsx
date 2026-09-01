"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "agora/ui";
import { useMemberSession } from "@/lib/member-client";

/** Customer member area. Placeholder — extend with your customer-facing features. */
export default function PortalHome() {
  const { member } = useMemberSession();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{member ? `, ${member.name}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          You&apos;re signed in as a customer of this workspace.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>Customer profile for this tenant.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{member?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{member?.email ?? "—"}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
