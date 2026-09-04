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
  Label,
  Field,
  Row,
  Stack,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Can,
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

type Me = { permissions: Record<string, string[]> };

export default function MembersPage() {
  const query = useListQuery();
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [editPhoneFor, setEditPhoneFor] = useState<{ id: string; phone: string } | null>(
    null,
  );
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const loadPendingCount = useCallback(async () => {
    const res = await api.rpc["member-profiles"]["pending-count"].$get();
    if (res.ok) {
      const body = await res.json();
      setPendingCount(body.pendingCount);
    }
  }, []);

  useEffect(() => {
    loadPendingCount();
  }, [loadPendingCount]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ permissions: body.permissions ?? {} });
      }
    })();
  }, []);

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
        loadPendingCount();
      } else if ((res.status as number) === 409) {
        toast.info("This application has already been approved.");
        loadAll();
        loadPendingCount();
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
        loadPendingCount();
      } else if ((res.status as number) === 409) {
        toast.info("This application has already been rejected.");
        loadAll();
        loadPendingCount();
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

  async function inviteMember(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    try {
      const res = await api.rpc["member-profiles"].invite.$post({
        json: { name: inviteName, email: inviteEmail },
      });
      if (res.ok) {
        const body = (await res.json()) as { resent: boolean };
        toast.success(body.resent ? "Invite resent." : "Invite sent.");
        setInviteOpen(false);
        setInviteName("");
        setInviteEmail("");
        loadAll();
        loadPendingCount();
      } else if ((res.status as number) === 409) {
        toast.error("A player with that email already exists.");
      } else if ((res.status as number) === 403) {
        toast.error("Only admins can invite players.");
      } else {
        toast.error("Could not send the invite.");
      }
    } finally {
      setInviting(false);
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
      toast.error("Only admins can edit players.");
    } else {
      toast.error("Could not update the player.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <Row items="center" gap={2}>
          <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
          {pendingCount ? (
            <Badge variant="warning">{pendingCount} pending</Badge>
          ) : null}
        </Row>
        <p className="text-sm text-muted-foreground">
          Review player membership applications and manage player details.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Players</CardTitle>
          <CardDescription>
            Review player membership applications and manage player details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row items="center" gap={2} className="justify-between">
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search players…"
              view={query.view}
              onViewChange={query.setView}
            />
            <Can permissions={me?.permissions} resource="memberProfile" action="invite">
              <Button onClick={() => setInviteOpen(true)}>Invite player</Button>
            </Can>
          </Row>

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
                    href="/admin/settings/customers"
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
                emptyMessage="No players yet."
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
                emptyMessage="No players yet."
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

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a player</DialogTitle>
          </DialogHeader>
          <form onSubmit={inviteMember} className="space-y-4">
            <Field>
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={inviting}>
                {inviting ? "Sending…" : "Send invite"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
