"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
} from "agora/ui";
import { useMemberSession } from "@/lib/member-client";
import {
  getMyMembership,
  applyForMembership,
  type MemberProfile,
} from "@/lib/member-application";

/** Customer member area. Placeholder — extend with your customer-facing features. */
export default function PortalHome() {
  const { member } = useMemberSession();

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getMyMembership().then(({ data }) => {
      if (!mounted) return;
      if (data) setProfile(data);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function onApply() {
    setApplying(true);
    setApplyError(null);
    const { data, error } = await applyForMembership();
    if (error) {
      setApplyError(error);
      setApplying(false);
    } else {
      setProfile(data);
      setApplying(false);
    }
  }

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

      <Card>
        <CardHeader>
          <CardTitle>Membership</CardTitle>
          <CardDescription>Your venue membership status.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : profile ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 items-center">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge
                  variant={
                    profile.applicationStatus === "approved"
                      ? "success"
                      : profile.applicationStatus === "rejected"
                        ? "destructive"
                        : "warning"
                  }
                  className="capitalize"
                >
                  {profile.applicationStatus}
                </Badge>
              </dd>
              {profile.phone ? (
                <>
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd>{profile.phone}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <div className="space-y-4">
              <p>You haven&apos;t applied for membership yet.</p>
              <Button onClick={onApply} disabled={applying}>
                {applying ? "Applying…" : "Apply for membership"}
              </Button>
              {applyError ? (
                <p className="text-sm text-destructive">{applyError}</p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
