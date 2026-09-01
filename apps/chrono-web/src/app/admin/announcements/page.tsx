"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  toast,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  Can,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { Announcement, AnnouncementSeverity, PaginationMeta } from "agora";
import { usePlatformPermissions } from "../layout";

const FILTER_KEYS = ["status", "type"];

const SEVERITY_VARIANT: Record<AnnouncementSeverity, "default" | "warning" | "secondary"> = {
  critical: "default",
  warning: "warning",
  info: "secondary",
};

function statusOf(a: Announcement): "live" | "scheduled" | "expired" {
  const now = Date.now();
  if (new Date(a.startsAt).getTime() > now) return "scheduled";
  if (a.endsAt && new Date(a.endsAt).getTime() < now) return "expired";
  return "live";
}

/**
 * Platform-wide announcements — a growing historical log (no soft-delete;
 * "retire" only sets `endsAt`), same shape as `/admin/audit`, so this is
 * server-paginated via `useListQuery(FILTER_KEYS)` — not the
 * `useClientListPage` low-cardinality exemption.
 */
export default function AnnouncementsPage() {
  const permissions = usePlatformPermissions();
  const [items, setItems] = useState<Announcement[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const query = useListQuery(FILTER_KEYS);

  const load = useCallback(async () => {
    setLoading(true);
    const q: Record<string, string> = {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...query.filters,
    };
    if (query.q.trim()) q.q = query.q.trim();
    if (query.sort) {
      q.sort = query.sort;
      q.order = query.order;
    }
    const res = await adminApi["rpc-admin"].announcements.$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as Announcement[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRetire(id: string) {
    const res = await adminApi["rpc-admin"].announcements[":id"].retire.$post({
      param: { id },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not retire this announcement.");
      return;
    }
    load();
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this announcement? This cannot be undone.")) return;
    const res = await adminApi["rpc-admin"].announcements[":id"].$delete({
      param: { id },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not delete this announcement.");
      return;
    }
    load();
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Platform announcements are available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<Announcement>[] = [
    {
      key: "message",
      header: "Message",
      render: (a) => (
        <span className="line-clamp-1 max-w-[320px] text-sm">{a.message}</span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      sortable: true,
      render: (a) => (
        <div className="flex gap-2">
          <Badge variant={SEVERITY_VARIANT[a.severity]}>{a.severity}</Badge>
          <Badge variant="outline" className="capitalize">{a.type}</Badge>
        </div>
      ),
    },
    {
      key: "window",
      header: "Window",
      render: (a) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {new Date(a.startsAt).toLocaleString()} →{" "}
          {a.endsAt ? new Date(a.endsAt).toLocaleString() : "open-ended"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (a) => {
        const status = statusOf(a);
        return (
          <Badge
            variant={
              status === "live" ? "success" : status === "expired" ? "outline" : "secondary"
            }
          >
            {status}
          </Badge>
        );
      },
    },
    {
      key: "actions",
      header: "",
      render: (a) => (
        <Can permissions={permissions} resource="announcement" action="manage">
          <div className="flex justify-end gap-2">
            {statusOf(a) === "live" ? (
              <Button variant="outline" size="sm" onClick={() => handleRetire(a.id)}>
                Retire
              </Button>
            ) : null}
            <Link href={`/admin/announcements/${a.id}`}>
              <Button variant="outline" size="sm">
                Edit
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => handleDelete(a.id)}
            >
              Delete
            </Button>
          </div>
        </Can>
      ),
    },
  ];

  return (
    <Stack>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Announcements</h1>
          <p className="text-sm text-muted-foreground">
            Platform-wide banners shown to every signed-in tenant member, on every
            tenant, until retired or expired.
          </p>
        </div>
        <Can permissions={permissions} resource="announcement" action="manage">
          <Link href="/admin/announcements/new">
            <Button>New announcement</Button>
          </Link>
        </Can>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search message"
        view={query.view}
        onViewChange={query.setView}
      >
        <Select
          value={query.filters.status ?? "all"}
          onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={query.filters.type ?? "all"}
          onValueChange={(v) => query.setFilters({ type: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="maintenance">Maintenance</SelectItem>
            <SelectItem value="security">Security</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="billing">Billing</SelectItem>
            <SelectItem value="feature">Feature</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      {query.view === "grid" ? (
        <DataTableGrid
          rows={items}
          rowKey={(a) => a.id}
          loading={loading}
          emptyMessage="No announcements yet."
          renderCard={(a) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Badge variant={SEVERITY_VARIANT[a.severity]}>{a.severity}</Badge>
                <Badge variant="outline">{statusOf(a)}</Badge>
              </div>
              <p className="text-sm">{a.message}</p>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(a) => a.id}
          loading={loading}
          emptyMessage="No announcements yet."
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}
    </Stack>
  );
}
