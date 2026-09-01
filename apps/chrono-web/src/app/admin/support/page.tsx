"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Card,
  CardContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  SupportTicketSummary,
  SupportTicketPriority,
  SupportTicketStatus,
  PaginationMeta,
} from "agora";
import { usePlatformPermissions } from "../layout";
import { NewTicketDialog } from "./new-ticket-dialog";

const FILTER_KEYS = ["queue"];

const PRIORITY_VARIANT: Record<
  SupportTicketPriority,
  "destructive" | "warning" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

const STATUS_VARIANT: Record<
  SupportTicketStatus,
  "default" | "secondary" | "success" | "outline"
> = {
  open: "default",
  pending: "secondary",
  assigned: "secondary",
  resolved: "success",
  closed: "outline",
};

/**
 * Platform support console queue. A growing, cross-tenant log, so it is
 * server-paginated via `useListQuery(FILTER_KEYS)` — not the low-cardinality
 * `useClientListPage` exemption. Reads gate on `supportTicket:read`; the "New
 * ticket" dialog is `supportTicket:manage`-gated inside `NewTicketDialog`.
 */
export default function SupportQueuePage() {
  const permissions = usePlatformPermissions();
  const [items, setItems] = useState<SupportTicketSummary[]>([]);
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
    const res = await adminApi["rpc-admin"]["support-tickets"].$get({ query: q });
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setItems(body.items as SupportTicketSummary[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order, query.filters]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              The support console is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const columns: DataTableColumn<SupportTicketSummary>[] = [
    {
      key: "id",
      header: "Ticket",
      render: (t) => (
        <Link
          href={`/admin/support/${t.id}`}
          className="font-mono text-xs text-primary hover:underline"
        >
          {t.id.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: "tenant",
      header: "Tenant",
      render: (t) => (
        <span className="text-sm">{t.organizationName ?? t.organizationId}</span>
      ),
    },
    {
      key: "requester",
      header: "Requester",
      render: (t) => (
        <span className="text-sm text-muted-foreground">{t.requesterLabel ?? "—"}</span>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (t) => (
        <Link href={`/admin/support/${t.id}`} className="hover:underline">
          <span className="line-clamp-1 max-w-[280px] text-sm">{t.subject}</span>
        </Link>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      sortable: true,
      render: (t) => <Badge variant={PRIORITY_VARIANT[t.priority]}>{t.priority}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (t) => <Badge variant={STATUS_VARIANT[t.status]}>{t.status}</Badge>,
    },
    {
      key: "agent",
      header: "Assigned",
      render: (t) => (
        <span className="text-sm text-muted-foreground">
          {t.assignedAgentName ?? "Unassigned"}
        </span>
      ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      sortable: true,
      render: (t) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {new Date(t.updatedAt).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <Stack>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
          <p className="text-sm text-muted-foreground">
            Native support tickets across every tenant, worked by platform staff.
          </p>
        </div>
        <NewTicketDialog permissions={permissions} onCreated={load} />
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search subject"
      >
        <Select
          value={query.filters.queue ?? "all"}
          onValueChange={(v) => query.setFilters({ queue: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tickets</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="assigned">Assigned</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </DataTableToolbar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(t) => t.id}
        loading={loading}
        emptyMessage="No tickets in this view."
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
      />

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
