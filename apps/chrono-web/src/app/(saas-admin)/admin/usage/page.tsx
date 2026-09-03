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
  Button,
  Stack,
  Row,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  UsageOverview,
  UsageTenantRow,
  TenantResourceUsage,
  LimitStatus,
  PaginationMeta,
  ListUsageTenantsQuery,
} from "agora";

/**
 * Cross-tenant usage & limits — reporting for `/admin/usage`, gated on the
 * `usage` platform permission (read here). Mirrors `/admin/metrics`'s
 * structure. Every figure traces to `GET /rpc-admin/usage/*`; a resource with
 * no data source renders "not metered", never a fabricated `0`.
 */
const FILTER_KEYS = ["plan", "status"];

const PLAN_OPTIONS = ["free", "pro", "enterprise"] as const;
const STATUS_OPTIONS: LimitStatus[] = [
  "ok",
  "approaching",
  "at",
  "over",
  "unlimited",
  "unmetered",
];

/** Badge color for a limit status. */
function statusVariant(status: LimitStatus): "success" | "warning" | "destructive" | "secondary" {
  if (status === "over") return "destructive";
  if (status === "at" || status === "approaching") return "warning";
  if (status === "ok" || status === "unlimited") return "success";
  return "secondary";
}

/** "used / limit (pct%)", or "not metered" / "unlimited" where those apply. */
function resourceLabel(r: TenantResourceUsage | undefined): string {
  if (!r) return "—";
  if (r.status === "unmetered" || r.used === null) return "not metered";
  if (r.limit === -1) return `${r.used} / ∞`;
  if (r.limit === null) return `${r.used}`;
  const pct = r.percent === null ? "" : ` (${r.percent}%)`;
  return `${r.used} / ${r.limit}${pct}`;
}

export default function PlatformUsagePage() {
  const query = useListQuery(FILTER_KEYS);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [items, setItems] = useState<UsageTenantRow[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [overviewRes, tenantsRes] = await Promise.all([
      adminApi["rpc-admin"].usage.overview.$get(),
      adminApi["rpc-admin"].usage.tenants.$get({
        query: {
          page: String(query.page),
          pageSize: String(query.pageSize),
          sort: query.sort as ListUsageTenantsQuery["sort"],
          order: query.order,
          ...query.filters,
        },
      }),
    ]);
    setLoading(false);
    if ((overviewRes.status as number) === 403 || (tenantsRes.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (overviewRes.ok) setOverview((await overviewRes.json()) as UsageOverview);
    if (tenantsRes.ok) {
      const body = await tenantsRes.json();
      setItems(body.items as UsageTenantRow[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Usage &amp; limits are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<UsageTenantRow>[] = [
    {
      key: "name",
      header: "Tenant",
      sortable: true,
      render: (r) => (
        <Link
          href={`/admin/organizations/${r.tenantId}`}
          className="font-medium hover:underline"
        >
          {r.tenantName}
          <span className="ml-2 text-xs text-muted-foreground">{r.tenantSlug}</span>
        </Link>
      ),
    },
    { key: "plan", header: "Plan", sortable: true, render: (r) => r.plan },
    {
      key: "seats",
      header: "Seats",
      render: (r) => (
        <span className="tabular-nums">
          {resourceLabel(r.resources.find((x) => x.resource === "seats"))}
        </span>
      ),
    },
    {
      key: "projects",
      header: "Projects",
      render: (r) => (
        <span className="tabular-nums">
          {resourceLabel(r.resources.find((x) => x.resource === "projects"))}
        </span>
      ),
    },
    {
      key: "worstStatus",
      header: "Limit status",
      render: (r) => <Badge variant={statusVariant(r.worstStatus)}>{r.worstStatus}</Badge>,
    },
    {
      key: "view",
      header: "",
      render: (r) => (
        <Link href={`/admin/organizations/${r.tenantId}`}>
          <Button variant="outline" size="sm">
            View
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage &amp; limits</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant usage against plan limits — read-only.
        </p>
      </div>

      {!loading && overview && overview.totalTenants === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No tenants yet.</CardTitle>
            <CardDescription>
              Usage will appear here once a business signs up.
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
              <p className="text-sm text-muted-foreground">Approaching limit</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.approachingCount > 0 ? (
                  <Badge variant="warning">{overview.approachingCount}</Badge>
                ) : (
                  overview.approachingCount
                )}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-[160px] flex-1">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Over limit</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {overview.overCount > 0 ? (
                  <Badge variant="destructive">{overview.overCount}</Badge>
                ) : (
                  overview.overCount
                )}
              </p>
            </CardContent>
          </Card>
        </Row>
      ) : null}

      {overview && overview.byPlan.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>By plan</CardTitle>
            <CardDescription>Tenant, member and project counts per plan.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={[
                { key: "plan", header: "Plan", render: (b) => b.plan },
                { key: "tenantCount", header: "Tenants", render: (b) => b.tenantCount },
                { key: "memberCount", header: "Members", render: (b) => b.memberCount },
                { key: "projectCount", header: "Projects", render: (b) => b.projectCount },
                {
                  key: "seatLimit",
                  header: "Seat limit",
                  render: (b) => (b.seatLimit === -1 ? "∞" : b.seatLimit),
                },
                {
                  key: "projectLimit",
                  header: "Project limit",
                  render: (b) => (b.projectLimit === -1 ? "∞" : b.projectLimit),
                },
              ]}
              rows={overview.byPlan}
              rowKey={(b) => b.plan}
              emptyMessage="No plans in use."
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Per-tenant usage</CardTitle>
          <CardDescription>
            Seat and project usage against each tenant&apos;s effective limit. Filters and the
            limit-status highlight apply within the current page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search tenants…"
            >
              <Select
                value={query.filters.plan ?? "all"}
                onValueChange={(v) => query.setFilters({ plan: v === "all" ? undefined : v })}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All plans" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {PLAN_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={query.filters.status ?? "all"}
                onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataTableToolbar>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(r) => r.tenantId}
              loading={loading}
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
              emptyMessage="No tenants match."
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
