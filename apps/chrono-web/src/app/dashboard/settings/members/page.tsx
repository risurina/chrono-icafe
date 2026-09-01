"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Badge,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Stack,
  Row,
  Can,
  can,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};
const STAFF_ROLES = ["staff", "admin", "owner"] as const;
type Invite = {
  id: string;
  email: string;
  role: string | null;
  status?: string;
  expiresAt?: string;
};
type Me = { userId: string; role: string; permissions: Record<string, string[]> };

export default function MembersSettingsPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const query = useListQuery();

  const loadMembers = useCallback(async () => {
    const m = await api.rpc.members.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (m.ok) {
      const body = await m.json();
      setMembers(body.items as Member[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  async function loadAll() {
    const [i, meRes] = await Promise.all([
      api.rpc.invites.$get(),
      api.rpc.me.$get(),
    ]);
    await loadMembers();
    if (i.ok) setInvites((await i.json()).invites as Invite[]);
    if (meRes.ok) {
      const body = (await meRes.json()) as Me;
      setMe({
        userId: body.userId,
        role: body.role,
        permissions: body.permissions ?? {},
      });
    }
  }

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    (async () => {
      const [i, meRes] = await Promise.all([
        api.rpc.invites.$get(),
        api.rpc.me.$get(),
      ]);
      if (i.ok) setInvites((await i.json()).invites as Invite[]);
      if (meRes.ok) {
        const body = (await meRes.json()) as Me;
        setMe({
          userId: body.userId,
          role: body.role,
          permissions: body.permissions ?? {},
        });
      }
    })();
  }, []);

  // Visibility only — each route enforces the same permission server-side.
  const canUpdateRole = can(me?.permissions, "staff", "update-role");
  const canRemove = can(me?.permissions, "staff", "remove");
  const canInvite = can(me?.permissions, "staff", "invite");
  const canTransferOwnership = can(
    me?.permissions,
    "tenant",
    "transfer-ownership",
  );

  async function changeMemberRole(id: string, role: string) {
    setMsg(null);
    const res = await api.rpc.members[":id"].role.$patch({
      param: { id },
      json: { role: role as (typeof STAFF_ROLES)[number] },
    });
    if (res.ok) {
      loadAll();
      setMsg("Member role updated.");
    } else if ((res.status as number) === 403) {
      setMsg("You can't assign a role above your own.");
    } else if ((res.status as number) === 409) {
      setMsg("Can't change the role of the last owner.");
    } else {
      setMsg("Could not update the member's role.");
    }
  }

  async function removeMember(id: string) {
    setMsg(null);
    const res = await api.rpc.members[":id"].$delete({ param: { id } });
    if (res.ok) {
      loadAll();
      setMsg("Member removed.");
    } else if ((res.status as number) === 403) {
      setMsg("You can't remove a member who outranks you.");
    } else if ((res.status as number) === 409) {
      setMsg("Can't remove the last owner — transfer ownership first.");
    } else {
      setMsg("Could not remove the member.");
    }
  }

  async function transferOwnership(id: string) {
    setMsg(null);
    const res = await api.rpc.members[":id"]["transfer-ownership"].$post({
      param: { id },
    });
    if (res.ok) {
      loadAll();
      setMsg("Ownership transferred. You are now an admin.");
    } else if ((res.status as number) === 403) {
      setMsg("Only the owner can transfer ownership.");
    } else {
      setMsg("Could not transfer ownership.");
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await api.rpc.invites.$post({
      json: { email: inviteEmail, role: "staff" },
    });
    if (res.ok) {
      const body = (await res.json()) as { emailSent?: boolean };
      setInviteEmail("");
      loadAll();
      setMsg(
        body.emailSent === false
          ? "Invitation created, but the email failed to send — use Resend."
          : "Invitation sent.",
      );
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can invite members.");
    } else {
      setMsg("Could not create invitation.");
    }
  }

  async function resendInvite(id: string) {
    setMsg(null);
    const res = await api.rpc.invites[":id"].resend.$post({ param: { id } });
    if (res.ok) setMsg("Invitation resent.");
    else if ((res.status as number) === 403) setMsg("Only admins can resend.");
    else setMsg("Could not resend invitation.");
  }

  async function revokeInvite(id: string) {
    setMsg(null);
    const res = await api.rpc.invites[":id"].$delete({ param: { id } });
    if (res.ok) {
      loadAll();
      setMsg("Invitation revoked.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can revoke.");
    } else {
      setMsg("Could not revoke invitation.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">
          People and invitations for this workspace.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* Members */}
      <Stack>
        <div>
          <h2 className="text-lg font-medium">Members</h2>
          <p className="text-sm text-muted-foreground">
            People with access to this workspace.
          </p>
        </div>

        <DataTableToolbar
          q={query.q}
          onQChange={query.setQ}
          searchPlaceholder="Search members…"
          view={query.view}
          onViewChange={query.setView}
        />

        {(() => {
          const renderRowActions = (m: Member) => {
            const isSelf = me?.userId === m.userId;
            return (
              <Row shrink items="center">
                {canUpdateRole ? (
                  <Select
                    value={m.role}
                    onValueChange={(v) => changeMemberRole(m.id, v)}
                  >
                    <SelectTrigger className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAFF_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary" className="capitalize">
                    {m.role}
                  </Badge>
                )}
                {canTransferOwnership && !isSelf ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => transferOwnership(m.id)}
                  >
                    Make owner
                  </Button>
                ) : null}
                {canRemove && !isSelf ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => removeMember(m.id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </Row>
            );
          };

          const columns: DataTableColumn<Member>[] = [
            { key: "name", header: "Name", sortable: true },
            { key: "email", header: "Email", sortable: true },
            { key: "actions", header: "", render: renderRowActions },
          ];

          return query.view === "grid" ? (
            <DataTableGrid
              rows={members}
              rowKey={(m) => m.id}
              emptyMessage="No members yet."
              renderCard={(m) => (
                <div className="space-y-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.email}
                    </p>
                  </div>
                  {renderRowActions(m)}
                </div>
              )}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={members}
              rowKey={(m) => m.id}
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
      </Stack>

      {/* Invitations */}
      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            {canInvite
              ? "Invite a teammate to this workspace."
              : "You don't have permission to invite teammates."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Can permissions={me?.permissions} resource="staff" action="invite">
            <form onSubmit={invite} className="flex gap-2">
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
              <Button type="submit">Invite</Button>
            </form>
          </Can>
          {invites.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {invites.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2"
                >
                  <span className="truncate">{i.email}</span>
                  <Row shrink items="center">
                    <Badge variant="secondary" className="capitalize">
                      {i.role}
                    </Badge>
                    <Can
                      permissions={me?.permissions}
                      resource="staff"
                      action="invite"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => resendInvite(i.id)}
                      >
                        Resend
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => revokeInvite(i.id)}
                      >
                        Revoke
                      </Button>
                    </Can>
                  </Row>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
