"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Stack,
  Row,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformMetricsOverview,
  PlatformSignupBucket,
  PlatformTenantUsageRow,
  PaginationMeta,
  ListPlatformTenantUsageQuery,
} from "agora";

/**
 * Cross-tenant usage/growth metrics — reporting-only (no mutating action),
 * gated on the existing `organization:read` platform permission. Mirrors
 * `/admin/billing`'s structure. No charting library in the repo, so the
 * signups series renders as a table (see plan's Risks — chart is a follow-up).
 */
export default function PlatformMetricsPage() {
  const query = useListQuery();
  const [overview, setOverview] = useState<PlatformMetricsOverview | null>(null);
  const [items, setItems] = useState<PlatformTenantUsageRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [overviewRes, tenantsRes] = await Promise.all([
      adminApi["rpc-admin"].metrics.overview.$get(),
      adminApi["rpc-admin"].metrics.tenants.$get({
        query: {
          page: String(query.page),
          pageSize: String(query.pageSize),
          sort: query.sort as ListPlatformTenantUsageQuery["sort"],
          order: query.order,
        },
      }),
    ]);
    setLoading(false);
    if ((overviewRes.status as number) === 403 || (tenantsRes.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (overviewRes.ok) {
      setOverview((await overviewRes.json()) as PlatformMetricsOverview);
    }
    if (tenantsRes.ok) {
      const body = await tenantsRes.json();
      setItems(body.items as PlatformTenantUsageRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Usage/growth metrics are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const signupColumns: DataTableColumn<PlatformSignupBucket>[] = [
    { key: "date", header: "Date", render: (b) => <span className="tabular-nums">{b.date}</span> },
    { key: "count", header: "Signups", render: (b) => <span className="tabular-nums">{b.count}</span> },
  ];

  const columns: DataTableColumn<PlatformTenantUsageRow>[] = [
    { key: "tenantName", header: "Tenant", render: (r) => r.tenantName },
    {
      key: "tenantSlug",
      header: "Slug",
      render: (r) => <span className="text-muted-foreground">{r.tenantSlug}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge
          variant={
            r.status === "active"
              ? "success"
              : r.status === "suspended"
                ? "warning"
                : "secondary"
          }
        >
          {r.status}
        </Badge>
      ),
    },
    { key: "createdAt", header: "Created", sortable: true, render: (r) => new Date(r.createdAt).toLocaleDateString() },
    { key: "memberCount", header: "Members", sortable: true, render: (r) => r.memberCount },
    { key: "projectCount", header: "Projects", render: (r) => r.projectCount },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant usage and growth reporting — read-only.
        </p>
      </div>

      {!loading && overview && overview.totalTenants === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No tenants yet.</CardTitle>
            <CardDescription>
              Metrics will appear here once a business signs up.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {overview && overview.totalTenants > 0 ? (
        <Row gap={4} wrap>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Total tenants</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.totalTenants}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Active</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.activeTenants}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Suspended</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.suspendedTenants}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Deleting</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.deletingTenants}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Total users</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.totalUsers}
              </p>
            </CardContent>
          </Card>
        </Row>
      ) : null}

      {overview ? (
        <Card>
          <CardHeader>
            <CardTitle>Signups (last 90 days)</CardTitle>
            <CardDescription>
              Organizations created per UTC day, zero-filled.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto">
              <DataTable
                columns={signupColumns}
                rows={overview.signups}
                rowKey={(b) => b.date}
                emptyMessage="No signups in this window."
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Per-tenant usage</CardTitle>
          <CardDescription>Member and project counts by tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(r) => r.tenantId}
              loading={loading}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No tenants yet."
            />
            {meta ? (
              <DataTablePagination
                meta={meta}
                onPageChange={query.setPage}
                onPageSizeChange={query.setPageSize}
              />
            ) : null}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
