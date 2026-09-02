"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Stack,
  toast,
} from "agora/ui";
import { api } from "@/lib/rpc";
import {
  OnboardingChecklistCard,
  type OnboardingChecklistState,
} from "@/components/dashboard/onboarding/onboarding-checklist-card";

type Me = { tenantSlug: string; role: string };

export default function OverviewPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingChecklistState | null>(null);

  useEffect(() => {
    (async () => {
      const meRes = await api.rpc.me.$get();
      if (!meRes.ok) {
        toast.error("Could not load your tenant. Are you a member of this workspace?");
        return;
      }
      setMe((await meRes.json()) as Me);
      const [p, m, b, o] = await Promise.all([
        api.rpc.projects.$get({ query: { pageSize: "1" } }),
        api.rpc.members.$get({ query: { pageSize: "1" } }),
        api.rpc.billing.$get(),
        api.rpc.onboarding.checklist.$get(),
      ]);
      if (p.ok) setProjectCount((await p.json()).meta.totalItems);
      if (m.ok) setMemberCount((await m.json()).meta.totalItems);
      // Billing is admin-gated; a staff-role user simply sees no plan badge.
      if (b.ok) setPlan((await b.json()).subscription.plan);
      if (o.ok) setOnboarding(await o.json());
    })();
  }, []);

  async function dismissOnboarding() {
    // Optimistic collapse — hide immediately, restore on failure.
    const previous = onboarding;
    setOnboarding(null);
    const res = await api.rpc.onboarding.checklist.dismiss.$post();
    if (!res.ok) {
      toast.error("Could not dismiss the checklist.");
      setOnboarding(previous);
      return;
    }
    setOnboarding(await res.json());
  }

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Workspace{" "}
          <span className="font-medium text-foreground">{me?.tenantSlug ?? "…"}</span>
          {me ? (
            <Badge variant="secondary" className="ml-2 align-middle capitalize">
              {me.role}
            </Badge>
          ) : null}
          {plan ? (
            <Badge variant="outline" className="ml-2 align-middle capitalize">
              {plan} plan
            </Badge>
          ) : null}
        </p>
      </div>

      {onboarding && !onboarding.dismissed ? (
        <OnboardingChecklistCard state={onboarding} onDismiss={dismissOnboarding} />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Projects</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {projectCount ?? "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Members</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {memberCount ?? "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Isolation</CardDescription>
            <CardTitle className="text-xl">RLS active</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Every query is scoped to this tenant by Postgres row-level security.
          </CardContent>
        </Card>
      </div>
    </Stack>
  );
}
