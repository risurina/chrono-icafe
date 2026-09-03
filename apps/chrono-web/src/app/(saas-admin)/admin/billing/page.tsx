"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Stack,
  DataTable,
  DataTablePagination,
  useListQuery,
  buttonVariants,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformBillingSummary,
  PlatformTenantBillingRow,
  PaginationMeta,
} from "agora";
import { PLAN_IDS, PLANS } from "agora/billing";

/**
 * Cross-tenant billing/revenue rollup — Stripe-gated. Reads only the mirrored
 * `tenant_subscription` table (never a live Stripe call). Renders two clearly
 * distinct states: "billing not configured" vs. "configured, zero tenants on
 * any plan" — never inferred from empty data, per the plan's Phase 4
 * acceptance criteria.
 */
export default function PlatformBillingPage() {
  const query = useListQuery();
  const [summary, setSummary] = useState<PlatformBillingSummary | null>(null);
  const [items, setItems] = useState<PlatformTenantBillingRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [summaryRes, tenantsRes] = await Promise.all([
      adminApi["rpc-admin"].billing.summary.$get(),
      adminApi["rpc-admin"].billing.tenants.$get({
        query: { page: String(query.page), pageSize: String(query.pageSize) },
      }),
    ]);
    setLoading(false);
    if ((summaryRes.status as number) === 403 || (tenantsRes.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (summaryRes.ok) {
      setSummary((await summaryRes.json()) as PlatformBillingSummary);
    }
    if (tenantsRes.ok) {
      const body = await tenantsRes.json();
      if (body.enabled) {
        setItems(body.items as PlatformTenantBillingRow[]);
        setMeta(body.meta as PaginationMeta);
      }
    }
  }, [query.page, query.pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The billing rollup is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<PlatformTenantBillingRow>[] = [
    { key: "tenantName", header: "Tenant", render: (r) => r.tenantName },
    {
      key: "tenantSlug",
      header: "Slug",
      render: (r) => <span className="text-muted-foreground">{r.tenantSlug}</span>,
    },
    {
      key: "planId",
      header: "Plan",
      render: (r) => <Badge variant="secondary">{r.planId}</Badge>,
    },
    { key: "status", header: "Status", render: (r) => r.status },
    {
      key: "currentPeriodEnd",
      header: "Current period ends",
      render: (r) => (
        <span className="text-muted-foreground">
          {r.currentPeriodEnd ? new Date(r.currentPeriodEnd).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      key: "stripeDashboardUrl",
      header: "",
      render: (r) =>
        r.stripeDashboardUrl ? (
          <a
            href={r.stripeDashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View in Stripe →
          </a>
        ) : null,
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant subscription rollup, mirrored from the active payment
          provider — read-only. For individual payments, invoices and refunds,
          see{" "}
          <Link href="/admin/transactions" className="underline">
            Transactions
          </Link>
          .
        </p>
      </div>

      {!loading && summary && !summary.enabled ? (
        <Card>
          <CardHeader>
            <CardTitle>Billing is not configured for this environment.</CardTitle>
            <CardDescription>
              No payment provider secret key is set, so subscription data cannot
              be read. The plan catalog below is code-defined and always
              available; per-tenant rollups appear once billing is configured.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Plan catalog</CardTitle>
          <CardDescription>
            Entitlements are enforced server-side regardless of billing
            configuration — this is the code-defined catalog, not live pricing.
            Advertised commercial metadata (display names, prices, trials,
            limits) is edited under{" "}
            <Link href="/admin/plans" className="underline">
              Plans
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {PLAN_IDS.map((planId) => {
              const plan = PLANS[planId];
              return (
                <Card key={planId} className="min-w-[220px]">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{plan.name}</Badge>
                    </div>
                    <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
                      <div className="flex justify-between gap-4">
                        <dt>Seats</dt>
                        <dd className="tabular-nums">
                          {plan.entitlements.seats === -1
                            ? "Unlimited"
                            : plan.entitlements.seats}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt>Projects</dt>
                        <dd className="tabular-nums">
                          {plan.entitlements.projects === -1
                            ? "Unlimited"
                            : plan.entitlements.projects}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt>Custom domains</dt>
                        <dd>{plan.entitlements.customDomains ? "Yes" : "No"}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt>Audit retention</dt>
                        <dd className="tabular-nums">
                          {plan.entitlements.auditRetentionDays}d
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {summary?.enabled ? (
        <Card>
          <CardHeader>
            <CardTitle>By plan &amp; status</CardTitle>
            <CardDescription>
              Tenant counts grouped by plan and subscription status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.counts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tenant is on any plan yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {summary.counts.map((c) => (
                  <Card key={`${c.planId}-${c.status}`} className="min-w-[160px]">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{c.planId}</Badge>
                        <span className="text-sm text-muted-foreground">{c.status}</span>
                      </div>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {c.tenantCount}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {summary?.enabled ? (
        <Stack gap={4}>
          <DataTable
            columns={columns}
            rows={items}
            rowKey={(r) => r.tenantId}
            loading={loading}
            emptyMessage="No tenant subscriptions yet."
          />
          {meta ? (
            <DataTablePagination
              meta={meta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
