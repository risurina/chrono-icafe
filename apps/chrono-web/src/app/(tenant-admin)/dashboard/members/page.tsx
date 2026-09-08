"use client";

import { useEffect, useCallback, useState } from "react";
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
  profileId: string | null;
  name: string;
  email: string;
  status: "active" | "suspended";
  phone: string | null;
  applicationStatus: "visitor" | "pending" | "approved" | "rejected" | null;
  appliedAt: string | null;
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
  const [createOpen, setCreateOpen] = useState(false);
  const [newCust, setNewCust] = useState({ email: "", name: "", password: "" });
  const [creating, setCreating] = useState(false);
  const [editCustFor, setEditCustFor] = useState<{
    memberId: string;
    name: string;
    email: string;
  } | null>(null);

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

  // ── Customer account actions (merged in from the retired Customers
  // settings page — see .ai/plans/chrono/active/customers-members-merge/README.md.
  // These act on the same tenantMember row as the player fields above; a row
  // with no chronoMemberProfile (profileId === null) only ever gets these. ──

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await api.rpc.customers.$post({ json: newCust });
      if (res.ok) {
        toast.success("Customer created.");
        setCreateOpen(false);
        setNewCust({ email: "", name: "", password: "" });
        loadAll();
      } else if ((res.status as number) === 403) {
        toast.error("Only admins can create customers.");
      } else if ((res.status as number) === 409) {
        toast.error("A customer with that email already exists.");
      } else {
        toast.error("Could not create the customer.");
      }
    } finally {
      setCreating(false);
    }
  }

  async function saveCustomerEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editCustFor) return;
    const res = await api.rpc.customers[":id"].$patch({
      param: { id: editCustFor.memberId },
      json: { name: editCustFor.name, email: editCustFor.email },
    });
    if (res.ok) {
      toast.success("Customer updated.");
      setEditCustFor(null);
      loadAll();
    } else if ((res.status as number) === 403) {
      toast.error("Only admins can edit customers.");
    } else if ((res.status as number) === 409) {
      toast.error("A customer with that email already exists.");
    } else {
      toast.error("Could not update the customer.");
    }
  }

  async function setCustomerSuspended(memberId: string, suspend: boolean) {
    const res = suspend
      ? await api.rpc.customers[":id"].suspend.$post({ param: { id: memberId } })
      : await api.rpc.customers[":id"].reactivate.$post({ param: { id: memberId } });
    if (res.ok) {
      toast.success(suspend ? "Customer suspended." : "Customer reactivated.");
      loadAll();
    } else if ((res.status as number) === 403) {
      toast.error("Only admins can change a customer's status.");
    } else {
      toast.error("Could not update the customer.");
    }
  }

  async function exportCustomer(memberId: string, email: string) {
    const res = await api.rpc.customers[":id"].export.$get({ param: { id: memberId } });
    if (!res.ok) {
      toast.error(
        (res.status as number) === 403
          ? "Only admins can export customer data."
          : "Could not export this customer.",
      );
      return;
    }
    const bundle = await res.json();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-${email}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Customer data exported.");
  }

  async function deleteCustomer(memberId: string) {
    const res = await api.rpc.customers[":id"].$delete({ param: { id: memberId } });
    if (res.ok) {
      toast.success("Customer data deleted.");
      loadAll();
    } else if ((res.status as number) === 403) {
      toast.error("Only admins can delete customer data.");
    } else {
      toast.error("Could not delete this customer.");
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
            <Row gap={2}>
              <Can permissions={me?.permissions} resource="customer" action="create">
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  Create customer
                </Button>
              </Can>
              <Can permissions={me?.permissions} resource="memberProfile" action="invite">
                <Button onClick={() => setInviteOpen(true)}>Invite player</Button>
              </Can>
            </Row>
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
              if (editCustFor?.memberId === member.memberId) {
                return (
                  <form
                    onSubmit={saveCustomerEdit}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Input
                      placeholder="Full name"
                      className="min-w-32 flex-1"
                      value={editCustFor.name}
                      onChange={(e) =>
                        setEditCustFor((s) => s && { ...s, name: e.target.value })
                      }
                      required
                    />
                    <Input
                      type="email"
                      placeholder="customer@example.com"
                      className="min-w-40 flex-1"
                      value={editCustFor.email}
                      onChange={(e) =>
                        setEditCustFor((s) => s && { ...s, email: e.target.value })
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
                      onClick={() => setEditCustFor(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                );
              }
              return (
                <Row shrink items="center">
                  <Badge
                    variant={member.status === "active" ? "success" : "warning"}
                    className="capitalize"
                  >
                    {member.status}
                  </Badge>

                  {member.profileId ? (
                    <Badge
                      variant={
                        member.applicationStatus === "approved"
                          ? "success"
                          : member.applicationStatus === "rejected"
                            ? "destructive"
                            : member.applicationStatus === "visitor"
                              ? "outline"
                              : "warning"
                      }
                      className="capitalize"
                    >
                      {member.applicationStatus}
                    </Badge>
                  ) : null}

                  {member.profileId && member.applicationStatus === "pending" ? (
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

                  {member.profileId ? (
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
                  ) : null}

                  <Can permissions={me?.permissions} resource="customer" action="update">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setEditCustFor({
                          memberId: member.memberId,
                          name: member.name,
                          email: member.email,
                        })
                      }
                    >
                      Edit
                    </Button>
                  </Can>
                  <Can
                    permissions={me?.permissions}
                    resource="customer"
                    action={member.status === "active" ? "suspend" : "reactivate"}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCustomerSuspended(member.memberId, member.status === "active")
                      }
                    >
                      {member.status === "active" ? "Suspend" : "Reactivate"}
                    </Button>
                  </Can>
                  <Can permissions={me?.permissions} resource="customer" action="export">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportCustomer(member.memberId, member.email)}
                    >
                      Export
                    </Button>
                  </Can>
                  <Can permissions={me?.permissions} resource="customer" action="delete">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => deleteCustomer(member.memberId)}
                    >
                      Delete
                    </Button>
                  </Can>
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a customer</DialogTitle>
          </DialogHeader>
          <form onSubmit={createCustomer} className="space-y-4">
            <Field>
              <Label htmlFor="new-cust-name">Full name</Label>
              <Input
                id="new-cust-name"
                value={newCust.name}
                onChange={(e) => setNewCust((s) => ({ ...s, name: e.target.value }))}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="new-cust-email">Email</Label>
              <Input
                id="new-cust-email"
                type="email"
                value={newCust.email}
                onChange={(e) => setNewCust((s) => ({ ...s, email: e.target.value }))}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="new-cust-password">Temp password</Label>
              <Input
                id="new-cust-password"
                type="password"
                value={newCust.password}
                onChange={(e) => setNewCust((s) => ({ ...s, password: e.target.value }))}
                required
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create customer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
