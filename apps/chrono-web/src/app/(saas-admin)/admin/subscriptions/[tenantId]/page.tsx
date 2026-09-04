"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Stack,
  CenteredMessage,
  DataTable,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformSubscriptionDetail,
  SubscriptionHistoryEvent,
  SubscriptionDisplayStatus,
} from "agora";

const DISPLAY_STATUS_VARIANT: Record<
  SubscriptionDisplayStatus,
  "success" | "secondary" | "outline" | "warning"
> = {
  active: "success",
  trial: "secondary",
  past_due: "warning",
  paused: "outline",
  canceled: "outline",
  expired: "warning",
};

function money(value: string | null, currency: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  const cur = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
}

function dt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * Platform-wide subscription detail for a single tenant. This is the PLATFORM
 * view (mirrored data, override metadata, full history) — distinct from the
 * tenant's own `/admin/settings/billing` self-service surface.
 */
export default function SubscriptionDetailPage() {
  const params = useParams<{ tenantId: string }>();
  const tenantId = params.tenantId;
  const [detail, setDetail] = useState<PlatformSubscriptionDetail | null>(null);
  const [history, setHistory] = useState<SubscriptionHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [detailRes, historyRes] = await Promise.all([
      adminApi["rpc-admin"].subscriptions[":tenantId"].$get({ param: { tenantId } }),
      adminApi["rpc-admin"].subscriptions[":tenantId"].history.$get({ param: { tenantId } }),
    ]);
    setLoading(false);
    if ((detailRes.status as number) === 404) {
      setNotFound(true);
      return;
    }
    if (detailRes.ok) setDetail((await detailRes.json()) as PlatformSubscriptionDetail);
    if (historyRes.ok) {
      const body = await historyRes.json();
      setHistory(body.items as SubscriptionHistoryEvent[]);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <CenteredMessage>Loading…</CenteredMessage>;
  if (notFound || !detail) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              No subscription found for this tenant.{" "}
              <Link href="/admin/subscriptions" className="underline">
                Back to Subscriptions
              </Link>
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const historyColumns: DataTableColumn<SubscriptionHistoryEvent>[] = [
    { key: "createdAt", header: "When", render: (e) => dt(e.createdAt) },
    {
      key: "plan",
      header: "Plan",
      render: (e) => `${e.previousPlan ?? "—"} → ${e.newPlan}`,
    },
    {
      key: "status",
      header: "Status",
      render: (e) => `${e.previousStatus ?? "—"} → ${e.newStatus}`,
    },
    { key: "source", header: "Source", render: (e) => <Badge variant="outline">{e.source}</Badge> },
  ];

  return (
    <Stack>
      <div>
        <Link href="/admin/subscriptions" className="text-sm text-muted-foreground underline">
          ← Subscriptions
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{detail.tenantName}</h1>
        <p className="text-sm text-muted-foreground">{detail.tenantSlug}</p>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>
            This is the platform-wide view of the tenant&apos;s subscription. The
            tenant manages their own billing at their dashboard
            (/admin/settings/billing); changes made here are staff overrides.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <Field label="Plan">
              <span className="flex items-center gap-2">
                <Badge variant="secondary">{detail.planLabel ?? detail.planKey}</Badge>
                {detail.manualOverride ? <Badge variant="outline">Manual override</Badge> : null}
              </span>
            </Field>
            <Field label="Status">
              <Badge variant={DISPLAY_STATUS_VARIANT[detail.displayStatus]}>
                {detail.displayStatus}
              </Badge>
            </Field>
            <Field label="Advertised price">{money(detail.price, detail.currency)}</Field>
            <Field label="Seats">{detail.seats === -1 ? "Unlimited" : detail.seats}</Field>
            <Field label="Payment status">{detail.paymentStatus}</Field>
            <Field label="Started">{dt(detail.startedAt)}</Field>
            <Field label="Renewal">{dt(detail.renewalAt)}</Field>
            <Field label="Trial ends">{dt(detail.trialEndsAt)}</Field>
          </dl>
        </CardContent>
      </Card>

      {detail.manualOverride ? (
        <Card>
          <CardHeader>
            <CardTitle>Manual override</CardTitle>
            <CardDescription>Set by platform staff — wins over webhook updates.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Reason">{detail.overrideReason ?? "—"}</Field>
              <Field label="By">{detail.overrideBy ?? "—"}</Field>
              <Field label="At">{dt(detail.overrideAt)}</Field>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Billing history</CardTitle>
          <CardDescription>Observed plan/status transitions for this tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={historyColumns}
            rows={history}
            rowKey={(e) => e.id}
            emptyMessage="No transitions recorded yet."
          />
        </CardContent>
      </Card>
    </Stack>
  );
}
