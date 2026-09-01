"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Stack,
  Row,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { SubscriptionDTO } from "agora";

type PaidPlan = "pro" | "enterprise";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

const STATUS_VARIANT: Record<string, "secondary" | "success" | "warning"> = {
  active: "success",
  trialing: "secondary",
  past_due: "warning",
  canceled: "warning",
};

export default function BillingPage() {
  const [sub, setSub] = useState<SubscriptionDTO | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    const res = await api.rpc.billing.$get();
    if (res.ok) {
      setSub((await res.json()).subscription as SubscriptionDTO);
    } else if ((res.status as number) === 403) {
      setForbidden(true);
    }
  }

  useEffect(() => {
    // Reflect the Stripe redirect back into a message.
    const status = new URLSearchParams(window.location.search).get("status");
    if (status === "success") {
      setMsg("Payment received — your plan updates as soon as Stripe confirms.");
    } else if (status === "cancel") {
      setMsg("Checkout canceled. No changes were made.");
    }
    load();
  }, []);

  async function upgrade(plan: PaidPlan) {
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.billing.checkout.$post({ json: { plan } });
    setBusy(false);
    if (res.ok) {
      window.location.href = (await res.json()).url;
    } else if ((res.status as number) === 403) {
      setMsg("Only the workspace owner can change the plan.");
    } else if ((res.status as number) === 400) {
      setMsg("Billing is not configured for this deployment.");
    } else {
      setMsg("Could not start checkout. Try again.");
    }
  }

  async function manage() {
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.billing.portal.$post();
    setBusy(false);
    if (res.ok) {
      window.location.href = (await res.json()).url;
    } else if ((res.status as number) === 403) {
      setMsg("Only the workspace owner can manage billing.");
    } else if ((res.status as number) === 409) {
      setMsg("Start a checkout first to create a billing account.");
    } else {
      setMsg("Could not open the billing portal. Try again.");
    }
  }

  if (forbidden) {
    return (
      <p className="text-sm text-destructive">
        Billing is visible to admins and owners only.
      </p>
    );
  }

  const ent = sub?.entitlements;
  const seatLabel =
    sub && sub.seats < 0 ? "Unlimited" : `${sub?.seatsUsed ?? 0} / ${sub?.seats ?? 0}`;

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your plan, seats, and subscription (owner only for changes).
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* Current plan */}
      <Card>
        <CardHeader>
          <Row items="center" justify="between" gap={0}>
            <div>
              <CardTitle>Current plan</CardTitle>
              <CardDescription>
                Managed securely by Stripe — no card details touch this app.
              </CardDescription>
            </div>
            {sub ? (
              <Row items="center">
                <Badge variant="secondary">{PLAN_LABELS[sub.plan] ?? sub.plan}</Badge>
                <Badge variant={STATUS_VARIANT[sub.status] ?? "secondary"}>
                  {sub.status}
                </Badge>
              </Row>
            ) : null}
          </Row>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row items="center" justify="between" gap={0}>
            <span className="text-muted-foreground">Seats</span>
            <span className="font-medium tabular-nums">{seatLabel}</span>
          </Row>
          <Row items="center" justify="between" gap={0}>
            <span className="text-muted-foreground">Custom domains</span>
            <span className="font-medium">
              {ent?.customDomains ? "Included" : "Not included"}
            </span>
          </Row>
          <Row items="center" justify="between" gap={0}>
            <span className="text-muted-foreground">Audit retention</span>
            <span className="font-medium tabular-nums">
              {ent ? `${ent.auditRetentionDays} days` : "—"}
            </span>
          </Row>
          {sub?.currentPeriodEnd ? (
            <Row items="center" justify="between" gap={0}>
              <span className="text-muted-foreground">Renews</span>
              <span className="font-medium">
                {new Date(sub.currentPeriodEnd).toLocaleDateString()}
              </span>
            </Row>
          ) : null}
          {sub?.manualOverride ? (
            <p className="text-xs text-muted-foreground">
              Plan set by Agora support
              {sub.overrideAt ? ` on ${new Date(sub.overrideAt).toLocaleDateString()}` : ""}.
            </p>
          ) : null}
        </CardContent>
        {sub?.billingEnabled ? (
          <CardFooter className="gap-2">
            <Button onClick={manage} variant="outline" disabled={busy}>
              Manage billing
            </Button>
          </CardFooter>
        ) : (
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              Billing is not configured for this deployment. Set{" "}
              <code>STRIPE_SECRET_KEY</code> to enable checkout.
            </p>
          </CardFooter>
        )}
      </Card>

      {/* Upgrade options */}
      <Card>
        <CardHeader>
          <CardTitle>Change plan</CardTitle>
          <CardDescription>
            Upgrade to unlock more seats and custom domains.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <PlanCard
            name="Pro"
            highlights={["20 seats", "Custom domains", "90-day audit retention"]}
            current={sub?.plan === "pro"}
            disabled={busy || !sub?.billingEnabled}
            onSelect={() => upgrade("pro")}
          />
          <PlanCard
            name="Enterprise"
            highlights={[
              "Unlimited seats",
              "Custom domains",
              "365-day audit retention",
            ]}
            current={sub?.plan === "enterprise"}
            disabled={busy || !sub?.billingEnabled}
            onSelect={() => upgrade("enterprise")}
          />
        </CardContent>
      </Card>
    </Stack>
  );
}

function PlanCard({
  name,
  highlights,
  current,
  disabled,
  onSelect,
}: {
  name: string;
  highlights: string[];
  current: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <Row items="center" justify="between" gap={0}>
          <CardTitle className="text-lg">{name}</CardTitle>
          {current ? <Badge variant="secondary">Current</Badge> : null}
        </Row>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button className="w-full" disabled={disabled || current} onClick={onSelect}>
          {current ? "Current plan" : `Upgrade to ${name}`}
        </Button>
      </CardFooter>
    </Card>
  );
}
