"use client";

import { useEffect, useCallback, useState } from "react";
import Link from "next/link";
import type { PaginationMeta } from "agora";
import {
  DataTable,
  DataTableGrid,
  DataTablePagination,
  DataTableToolbar,
  type DataTableColumn,
  useListQuery,
  Badge,
  Button,
  Input,
  Row,
  Stack,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  toast,
} from "agora/ui";
import { api } from "@/lib/rpc";

type Member = {
  memberId: string;
  name: string;
  email: string;
  phone: string | null;
  applicationStatus: "pending" | "approved" | "rejected";
  appliedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
};

export default function MembersPage() {
  const query = useListQuery();
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [editPhoneFor, setEditPhoneFor] = useState<{ id: string; phone: string } | null>(
    null,
  );
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  const loadAll = useCallback(async () => {
    const res = await api.rpc["member-profiles"].$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setMembers(body.items as Member[]);
      setMeta(body.meta as PaginationMeta);
    } else {
      setMembers([]);
      setMeta(null);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function approveMember(memberId: string) {
    setInFlight((prev) => new Set(prev).add(memberId));
    try {
      const res = await api.rpc["member-profiles"][":memberId"].approve.$post({
        param: { memberId },
      });
      if (res.ok) {
        toast.success("Application approved.");
        loadAll();
      } else if ((res.status as number) === 409) {
        toast.info("This application has already been approved.");
        loadAll();
      } else if ((res.status as number) === 403) {
        toast.error("Only admins can approve or reject applications.");
      } else {
        toast.error("Could not update the application.");
      }
    } finally {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(memberId);
        return next;
      });
    }
  }

  async function rejectMember(memberId: string) {
    setInFlight((prev) => new Set(prev).add(memberId));
    try {
      const res = await api.rpc["member-profiles"][":memberId"].reject.$post({
        param: { memberId },
      });
      if (res.ok) {
        toast.success("Application rejected.");
        loadAll();
      } else if ((res.status as number) === 409) {
        toast.info("This application has already been rejected.");
        loadAll();
      } else if ((res.status as number) === 403) {
        toast.error("Only admins can approve or reject applications.");
      } else {
        toast.error("Could not update the application.");
      }
    } finally {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(memberId);
        return next;
      });
    }
  }

  async function savePhoneEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editPhoneFor) return;
    const res = await api.rpc["member-profiles"][":memberId"].$patch({
      param: { memberId: editPhoneFor.id },
      json: { phone: editPhoneFor.phone },
    });
    if (res.ok) {
      toast.success("Phone updated.");
      setEditPhoneFor(null);
      loadAll();
    } else if ((res.status as number) === 403) {
      toast.error("Only admins can edit members.");
    } else {
      toast.error("Could not update the member.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">
          Review venue membership applications and manage member details.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Review venue membership applications and manage member details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search members…"
            view={query.view}
            onViewChange={query.setView}
          />

          {(() => {
            const renderRow = (member: Member) => {
              if (editPhoneFor?.id === member.memberId) {
                return (
                  <form
                    onSubmit={savePhoneEdit}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Input
                      placeholder="Phone number"
                      className="min-w-32 flex-1"
                      value={editPhoneFor.phone}
                      onChange={(e) =>
                        setEditPhoneFor((s) => s && { ...s, phone: e.target.value })
                      }
                      required
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditPhoneFor(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                );
              }
              return (
                <Row shrink items="center">
                  <Badge
                    variant={
                      member.applicationStatus === "approved"
                        ? "success"
                        : member.applicationStatus === "rejected"
                          ? "destructive"
                          : "warning"
                    }
                    className="capitalize"
                  >
                    {member.applicationStatus}
                  </Badge>

                  {member.applicationStatus === "pending" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={inFlight.has(member.memberId)}
                        onClick={() => approveMember(member.memberId)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={inFlight.has(member.memberId)}
                        onClick={() => rejectMember(member.memberId)}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditPhoneFor({
                        id: member.memberId,
                        phone: member.phone ?? "",
                      })
                    }
                  >
                    Edit phone
                  </Button>

                  <Link
                    href="/dashboard/settings/customers"
                    className="text-primary hover:underline text-sm ml-2"
                  >
                    Account
                  </Link>
                </Row>
              );
            };

            const columns: DataTableColumn<Member>[] = [
              { key: "name", header: "Name", sortable: true },
              { key: "email", header: "Email", sortable: true },
              {
                key: "phone",
                header: "Phone",
                render: (m) => m.phone || "—",
              },
              { key: "actions", header: "", render: renderRow },
            ];

            return query.view === "grid" ? (
              <DataTableGrid
                rows={members}
                rowKey={(member) => member.memberId}
                emptyMessage="No members yet."
                renderCard={(member) => (
                  <div className="space-y-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email}
                      </p>
                    </div>
                    {renderRow(member)}
                  </div>
                )}
              />
            ) : (
              <DataTable
                columns={columns}
                rows={members}
                rowKey={(member) => member.memberId}
                sort={query.sort}
                order={query.order}
                onSortChange={query.setSort}
                emptyMessage="No members yet."
              />
            );
          })()}

          {meta ? (
            <DataTablePagination
              meta={meta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </CardContent>
      </Card>
    </Stack>
  );
}
