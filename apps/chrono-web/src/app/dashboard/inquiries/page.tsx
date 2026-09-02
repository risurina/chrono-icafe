"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
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
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type Status = "new" | "assigned" | "in_progress" | "resolved" | "closed";
type Category =
  | "general"
  | "lost_and_found"
  | "feedback"
  | "billing"
  | "session_issue"
  | "account";

type Inquiry = {
  id: string;
  submitterName: string;
  submitterEmail: string;
  category: Category;
  subject: string;
  status: Status;
  assignedToUserId: string | null;
  createdAt: string;
};

type Member = { id: string; userId: string; name: string; email: string };

const FILTER_KEYS = ["status", "category", "assignedToUserId"];

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  new: "default",
  assigned: "secondary",
  in_progress: "warning",
  resolved: "success",
  closed: "secondary",
};

export default function InquiriesPage() {
  const query = useListQuery(FILTER_KEYS);
  const status = query.filters.status ?? "";
  const category = query.filters.category ?? "";
  const assignedToUserId = query.filters.assignedToUserId ?? "";

  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.members.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setMembers(body.items as Member[]);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const res = await api.rpc.inquiries.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        order: query.order,
        ...(query.q ? { q: query.q } : {}),
        ...(status ? { status: status as Status } : {}),
        ...(category ? { category: category as Category } : {}),
        ...(assignedToUserId ? { assignedToUserId } : {}),
      },
    });
    if (res.ok) {
      const body = await res.json();
      setInquiries(body.items as Inquiry[]);
      setMeta(body.meta as PaginationMeta);
    } else {
      setInquiries([]);
      setMeta(null);
    }
  }, [status, category, assignedToUserId, query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  function memberName(userId: string | null): string {
    if (!userId) return "Unassigned";
    return members.find((m) => m.userId === userId)?.name ?? userId;
  }

  const columns: DataTableColumn<Inquiry>[] = [
    {
      key: "createdAt",
      header: "Received",
      sortable: true,
      render: (i) => new Date(i.createdAt).toLocaleString(),
    },
    { key: "subject", header: "Subject", render: (i) => i.subject },
    {
      key: "submitter",
      header: "From",
      render: (i) => (
        <div>
          <div>{i.submitterName}</div>
          <div className="text-xs text-muted-foreground">{i.submitterEmail}</div>
        </div>
      ),
    },
    { key: "category", header: "Category", render: (i) => i.category.replace(/_/g, " ") },
    { key: "assignedToUserId", header: "Assigned to", render: (i) => memberName(i.assignedToUserId) },
    {
      key: "status",
      header: "Status",
      render: (i) => <Badge variant={STATUS_VARIANT[i.status]}>{i.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "actions",
      header: "",
      render: (i) => (
        <Link href={`/dashboard/inquiries/${i.id}`} className="text-sm underline underline-offset-4">
          Open
        </Link>
      ),
    },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inquiries</h1>
        <p className="text-sm text-muted-foreground">
          Customer inquiries submitted from the portal and public contact form.
        </p>
      </div>

      <Row items="center">
        <div className="w-44">
          <Select
            value={status || "all"}
            onValueChange={(v) => query.setFilters({ status: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="assigned">Assigned</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <Select
            value={category || "all"}
            onValueChange={(v) => query.setFilters({ category: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              <SelectItem value="general">General</SelectItem>
              <SelectItem value="lost_and_found">Lost and found</SelectItem>
              <SelectItem value="feedback">Feedback</SelectItem>
              <SelectItem value="billing">Billing</SelectItem>
              <SelectItem value="session_issue">Session issue</SelectItem>
              <SelectItem value="account">Account</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <Select
            value={assignedToUserId || "all"}
            onValueChange={(v) => query.setFilters({ assignedToUserId: v === "all" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Any assignee" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any assignee</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Row>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search inquiries…"
        view={query.view}
        onViewChange={query.setView}
      />

      <DataTable
        columns={columns}
        rows={inquiries}
        rowKey={(i) => i.id}
        sort={query.sort}
        order={query.order}
        onSortChange={query.setSort}
        emptyMessage="No inquiries."
      />

      {meta ? (
        <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} />
      ) : null}
    </Stack>
  );
}
