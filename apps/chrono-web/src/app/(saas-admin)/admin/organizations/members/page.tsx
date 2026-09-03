"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Button,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Row,
  Stack,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
  Can,
  Label,
  Textarea,
  toast,
} from "agora/ui";
import { MoreHorizontal } from "lucide-react";
import { adminApi } from "@/lib/admin-client";
import { useSession } from "@/lib/auth-client";
import { usePlatformPermissions } from "../../layout";
import type { PaginationMeta, PlatformUserSummary, PlatformUserDetail } from "agora";

// This search covers platform staff and tenant organization members only — the
// shared Better-Auth `user` pool. A tenant's own end-customers (`tenant_member`)
// are a separate system with their own per-tenant suspend/reactivate mechanism
// and are never searched, shown, or affected here.
const SCOPE_COPY =
  "All platform accounts — tenant members and staff.";

type MutatingAction =
  | "ban"
  | "unban"
  | "revoke-sessions"
  | "send-password-reset"
  | "edit"
  | "reset-mfa"
  | "assign-role"
  | "move-tenant"
  | "delete";

const ANY = "all";

export default function PlatformAdminMembersPage() {
  const permissions = usePlatformPermissions();
  const { data: session } = useSession();
  const query = useListQuery([
    "organizationId",
    "role",
    "status",
    "credentialKind",
    "lastActiveWithinDays",
  ]);
  const [items, setItems] = useState<PlatformUserSummary[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(false);
    const [detail, setDetail] = useState<PlatformUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    user: PlatformUserSummary;
    action: MutatingAction;
  } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [roleInput, setRoleInput] = useState("");
  const [targetOrgId, setTargetOrgId] = useState("");
  const [fromOrgId, setFromOrgId] = useState("");

  const setFilter = useCallback(
    (key: string, value: string) => {
      query.setFilters({ [key]: value === ANY ? undefined : value });
    },
    [query],
  );

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setLoading(true);
      const res = await adminApi["rpc-admin"].users.$get({
        query: {
          page: String(query.page),
          pageSize: String(query.pageSize),
          ...(query.q ? { q: query.q } : {}),
          ...query.filters,
          accountKind: ((query.filters.accountKind as string) ?? "tenant_member") as "any" | "platform_staff" | "tenant_member",
        },
      });
      if (signal.cancelled) return;
      setLoading(false);
      if (!res.ok) {
        toast.error("Could not load users.");
        return;
      }
      const body = await res.json();
      setItems(body.items as PlatformUserSummary[]);
      setMeta(body.meta as PaginationMeta);
    },
    [query.page, query.pageSize, query.q],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  async function openDetail(user: PlatformUserSummary) {
    setDetailLoading(true);
    setDetail(null);
    const res = await adminApi["rpc-admin"].users[":userId"].$get({
      param: { userId: user.id },
    });
    setDetailLoading(false);
    if (res.ok) {
      setDetail((await res.json()) as PlatformUserDetail);
    } else {
      toast.error("Could not load this user's detail.");
    }
  }

  function openConfirm(user: PlatformUserSummary, action: MutatingAction) {
    setBanReason("");
    setEditName(user.name);
    setEditEmail(user.email);
    setRoleInput("");
    setTargetOrgId("");
    setFromOrgId(
      user.memberships && user.memberships.length === 1
        ? user.memberships[0]?.organizationId || ""
        : "",
    );
    setConfirmTarget({ user, action });
  }

  async function performAction() {
    if (!confirmTarget) return;
        const { user, action } = confirmTarget;

    let res: Response;
    if (action === "ban") {
      res = await adminApi["rpc-admin"].users[":userId"].ban.$patch({
        param: { userId: user.id },
        json: { banReason },
      });
    } else if (action === "unban") {
      res = await adminApi["rpc-admin"].users[":userId"].unban.$patch({
        param: { userId: user.id },
      });
    } else if (action === "revoke-sessions") {
      res = await adminApi["rpc-admin"].users[":userId"]["revoke-sessions"].$post({
        param: { userId: user.id },
      });
    } else if (action === "send-password-reset") {
      res = await adminApi["rpc-admin"].users[":userId"]["send-password-reset"].$post({
        param: { userId: user.id },
      });
    } else if (action === "edit") {
      res = await adminApi["rpc-admin"].users[":userId"].$patch({
        param: { userId: user.id },
        json: { name: editName, email: editEmail },
      });
    } else if (action === "reset-mfa") {
      res = await adminApi["rpc-admin"].users[":userId"]["reset-mfa"].$post({
        param: { userId: user.id },
      });
    } else if (action === "assign-role") {
      res = await adminApi["rpc-admin"].users[":userId"]["assign-role"].$post({
        param: { userId: user.id },
        json: { organizationId: targetOrgId, role: roleInput },
      });
    } else if (action === "move-tenant") {
      res = await adminApi["rpc-admin"].users[":userId"]["move-tenant"].$post({
        param: { userId: user.id },
        json: {
          fromOrganizationId: fromOrgId,
          toOrganizationId: targetOrgId,
          role: roleInput,
        },
      });
    } else if (action === "delete") {
      res = await adminApi["rpc-admin"].users[":userId"].$delete({
        param: { userId: user.id },
      });
    } else {
      throw new Error("Unknown action");
    }

    setConfirmTarget(null);
    if (res.ok) {
      toast.success(successMessage(user.email, action));
      load({ cancelled: false });
      if (detail?.id === user.id) openDetail(user);
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not complete this action.");
    }
  }

  const searchParams = useSearchParams();
  useEffect(() => {
    const userId = searchParams.get("user");
    if (!userId) return;
    let cancelled = false;
    setDetailLoading(true);
    adminApi["rpc-admin"].users[":userId"].$get({ param: { userId } }).then(async (res) => {
      if (cancelled) return;
      setDetailLoading(false);
      if (res.ok) setDetail((await res.json()) as PlatformUserDetail);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSelf = confirmTarget?.user.id === session?.user.id;

  const columns: DataTableColumn<PlatformUserSummary>[] = [
    {
      key: "email",
      header: "Email",
      render: (u) => (
        <Button variant="link" size="sm" onClick={() => openDetail(u)}>
          {u.email}
        </Button>
      ),
    },
    { key: "name", header: "Name", render: (u) => u.name },
    {
      key: "status",
      header: "Status",
      render: (u) => {
        if (u.deletedAt || u.status === "deleted") {
          return <Badge variant="destructive">Deleted</Badge>;
        }
        return (
          <Badge variant={u.banned ? "warning" : "success"}>
            {u.banned ? "Disabled" : "Active"}
          </Badge>
        );
      },
    },
    {
      key: "organization",
      header: "Organization",
      render: (u) => (
        <Row gap={1} wrap>
          {u.memberships.length === 0 ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            u.memberships.map((m) => (
              <Badge key={m.organizationId} variant="secondary">
                {m.organizationName}
              </Badge>
            ))
          )}
        </Row>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (u) => (
        <Row gap={1} wrap>
          {u.memberships.length === 0 ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            u.memberships.map((m) => (
              <Badge key={m.organizationId} variant="outline">
                {m.role}
              </Badge>
            ))
          )}
        </Row>
      ),
    },
    {
      key: "mfa",
      header: "MFA",
      render: (u) => (
        <Badge variant={u.mfaEnabled ? "success" : "secondary"}>
          {u.mfaEnabled ? "Enabled" : "Off"}
        </Badge>
      ),
    },
    {
      key: "lastActive",
      header: "Last active",
      render: (u) =>
        u.lastActiveAt ? (
          new Date(u.lastActiveAt).toLocaleDateString()
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (u) => new Date(u.createdAt).toLocaleDateString(),
    },
    {
      key: "actions",
      header: "",
      render: (u) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open menu">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <Can permissions={permissions} resource="user" action="edit">
              <DropdownMenuItem onClick={() => openConfirm(u, "edit")}>
                Edit
              </DropdownMenuItem>
            </Can>
            <Can permissions={permissions} resource="user" action="resetMfa">
              <DropdownMenuItem onClick={() => openConfirm(u, "reset-mfa")}>
                Reset MFA
              </DropdownMenuItem>
            </Can>
            <Can permissions={permissions} resource="user" action="assignRole">
              <DropdownMenuItem onClick={() => openConfirm(u, "assign-role")}>
                Assign role
              </DropdownMenuItem>
            </Can>
            <Can permissions={permissions} resource="user" action="moveTenant">
              <DropdownMenuItem onClick={() => openConfirm(u, "move-tenant")}>
                Move tenant
              </DropdownMenuItem>
            </Can>
            <Can permissions={permissions} resource="user" action="delete">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => openConfirm(u, "delete")}
              >
                Delete account
              </DropdownMenuItem>
            </Can>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">{SCOPE_COPY}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization members</CardTitle>
          <CardDescription>{SCOPE_COPY}</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTableToolbar
              q={query.q}
              onQChange={query.setQ}
              searchPlaceholder="Search by email or name (min. 2 characters)…"
            >
              <Row gap={2} className="flex-wrap items-end">
                <Stack gap={1}>
                  <Label className="text-xs">Account type</Label>
                  <Select
                    value={(query.filters.accountKind as string) ?? "tenant_member"}
                    onValueChange={(v) => setFilter("accountKind", v)}
                  >
                    <SelectTrigger className="h-9 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tenant_member">Members</SelectItem>
                      <SelectItem value="platform_staff">Staff</SelectItem>
                      <SelectItem value="any">All</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Organization</Label>
                  <Input
                    className="h-9 w-40"
                    placeholder="Org ID"
                    value={query.filters.organizationId ?? ""}
                    onChange={(e) => setFilter("organizationId", e.target.value || ANY)}
                  />
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Role</Label>
                  <Select
                    value={query.filters.role ?? ANY}
                    onValueChange={(v) => setFilter("role", v)}
                  >
                    <SelectTrigger className="h-9 w-32">
                      <SelectValue placeholder="Any role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any role</SelectItem>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={query.filters.status ?? ANY}
                    onValueChange={(v) => setFilter("status", v)}
                  >
                    <SelectTrigger className="h-9 w-32">
                      <SelectValue placeholder="Any status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any status</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                      <SelectItem value="deleted">Deleted</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Credential</Label>
                  <Select
                    value={query.filters.credentialKind ?? ANY}
                    onValueChange={(v) => setFilter("credentialKind", v)}
                  >
                    <SelectTrigger className="h-9 w-36">
                      <SelectValue placeholder="Any credential" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any credential</SelectItem>
                      <SelectItem value="credential">Password</SelectItem>
                      <SelectItem value="social">Social</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
                <Stack gap={1}>
                  <Label className="text-xs">Active Within</Label>
                  <Select
                    value={query.filters.lastActiveWithinDays ?? ANY}
                    onValueChange={(v) => setFilter("lastActiveWithinDays", v)}
                  >
                    <SelectTrigger className="h-9 w-36">
                      <SelectValue placeholder="Any time" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any time</SelectItem>
                      <SelectItem value="7">7 Days</SelectItem>
                      <SelectItem value="30">30 Days</SelectItem>
                      <SelectItem value="90">90 Days</SelectItem>
                    </SelectContent>
                  </Select>
                </Stack>
              </Row>
            </DataTableToolbar>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(u) => u.id}
              loading={loading}
              emptyMessage={
                query.q && query.q.length > 0
                  ? `No matching platform staff or tenant organization members found. ${SCOPE_COPY}`
                  : "No users found."
              }
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

      <Dialog
        open={detail !== null || detailLoading}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.email ?? "Loading…"}</DialogTitle>
            <DialogDescription>Account detail and actions.</DialogDescription>
          </DialogHeader>
          {detail ? (
            <Stack gap={4}>
              <Row gap={2}>
                <Badge variant={detail.banned ? "warning" : "success"}>
                  {detail.banned ? "Disabled" : "Active"}
                </Badge>
                {detail.banned && detail.banReason ? (
                  <span className="text-sm text-muted-foreground">
                    Reason: {detail.banReason}
                  </span>
                ) : null}
              </Row>
              <div className="text-sm text-muted-foreground">
                Active sessions: {detail.activeSessionCount} · Linked sign-in methods:{" "}
                {detail.linkedProviders.length > 0
                  ? detail.linkedProviders.join(", ")
                  : "none"}
              </div>
              <Row gap={1} wrap>
                {detail.memberships.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    No tenant memberships.
                  </span>
                ) : (
                  detail.memberships.map((m) => (
                    <Badge key={m.organizationId} variant="secondary">
                      {m.organizationName} ({m.role})
                    </Badge>
                  ))
                )}
              </Row>
              <Row gap={2} wrap>
                <Can permissions={permissions} resource="user" action="disable">
                  {detail.banned ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openConfirm(detail, "unban")}
                    >
                      Unban
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={detail.id === session?.user.id}
                      onClick={() => openConfirm(detail, "ban")}
                    >
                      Disable account
                    </Button>
                  )}
                </Can>
                <Can permissions={permissions} resource="user" action="resetSessions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openConfirm(detail, "revoke-sessions")}
                  >
                    Revoke all sessions
                  </Button>
                </Can>
                <Can
                  permissions={permissions}
                  resource="user"
                  action="sendPasswordReset"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!detail.hasCredentialAccount}
                    onClick={() => openConfirm(detail, "send-password-reset")}
                  >
                    Send password reset email
                  </Button>
                </Can>
              </Row>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTitle(confirmTarget?.action)}</DialogTitle>
            <DialogDescription>
              {confirmDescription(confirmTarget, isSelf)}
            </DialogDescription>
          </DialogHeader>
          {confirmTarget?.action === "ban" ? (
            <Stack gap={2}>
              <Label htmlFor="ban-reason">Reason</Label>
              <Textarea
                id="ban-reason"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Why is this account being disabled?"
              />
            </Stack>
          ) : null}
          {confirmTarget?.action === "edit" ? (
            <Stack gap={4}>
              <Stack gap={2}>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </Stack>
              <Stack gap={2}>
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                />
              </Stack>
            </Stack>
          ) : null}
          {confirmTarget?.action === "assign-role" ? (
            <Stack gap={4}>
              <Stack gap={2}>
                <Label htmlFor="assign-org">Organization ID</Label>
                <Input
                  id="assign-org"
                  value={targetOrgId}
                  onChange={(e) => setTargetOrgId(e.target.value)}
                  placeholder="Organization ID"
                />
              </Stack>
              <Stack gap={2}>
                <Label htmlFor="assign-role">Role</Label>
                <Input
                  id="assign-role"
                  value={roleInput}
                  onChange={(e) => setRoleInput(e.target.value)}
                  placeholder="owner, admin, staff, member, etc."
                />
              </Stack>
            </Stack>
          ) : null}
          {confirmTarget?.action === "move-tenant" ? (
            <Stack gap={4}>
              <Stack gap={2}>
                <Label htmlFor="move-from-org">From Organization ID</Label>
                <Input
                  id="move-from-org"
                  value={fromOrgId}
                  onChange={(e) => setFromOrgId(e.target.value)}
                  placeholder="From Organization ID"
                />
              </Stack>
              <Stack gap={2}>
                <Label htmlFor="move-to-org">To Organization ID</Label>
                <Input
                  id="move-to-org"
                  value={targetOrgId}
                  onChange={(e) => setTargetOrgId(e.target.value)}
                  placeholder="To Organization ID"
                />
              </Stack>
              <Stack gap={2}>
                <Label htmlFor="move-role">Role</Label>
                <Input
                  id="move-role"
                  value={roleInput}
                  onChange={(e) => setRoleInput(e.target.value)}
                  placeholder="owner, admin, staff, member, etc."
                />
              </Stack>
            </Stack>
          ) : null}
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button
                onClick={performAction}
                disabled={
                  (confirmTarget?.action === "ban" && banReason.trim().length === 0) ||
                  (confirmTarget?.action === "assign-role" &&
                    (!targetOrgId || !roleInput)) ||
                  (confirmTarget?.action === "move-tenant" &&
                    (!fromOrgId || !targetOrgId || !roleInput)) ||
                  (confirmTarget?.action === "edit" && editName.trim().length === 0) ||
                  // A platform admin cannot delete / move / reset-MFA their own
                  // account (the server 400s on these too — see routes.ts).
                  (isSelf &&
                    (confirmTarget?.action === "delete" ||
                      confirmTarget?.action === "move-tenant" ||
                      confirmTarget?.action === "reset-mfa"))
                }
              >
                Confirm
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

function successMessage(email: string, action: MutatingAction): string {
  switch (action) {
    case "ban":
      return `${email} was disabled.`;
    case "unban":
      return `${email} was re-enabled.`;
    case "revoke-sessions":
      return `${email}'s sessions were revoked.`;
    case "send-password-reset":
      return `A password reset email was sent to ${email}.`;
    case "edit":
      return `${email} was updated.`;
    case "reset-mfa":
      return `${email}'s MFA was reset.`;
    case "assign-role":
      return `${email}'s role was updated.`;
    case "move-tenant":
      return `${email} was moved to a new tenant.`;
    case "delete":
      return `${email} was deleted.`;
  }
}

function confirmTitle(action: MutatingAction | undefined): string {
  switch (action) {
    case "ban":
      return "Disable account?";
    case "unban":
      return "Re-enable account?";
    case "revoke-sessions":
      return "Revoke all sessions?";
    case "send-password-reset":
      return "Send password reset email?";
    case "edit":
      return "Edit user?";
    case "reset-mfa":
      return "Reset MFA?";
    case "assign-role":
      return "Assign role?";
    case "move-tenant":
      return "Move tenant?";
    case "delete":
      return "Delete account?";
    default:
      return "";
  }
}

function confirmDescription(
  confirmTarget: { user: PlatformUserSummary; action: MutatingAction } | null,
  isSelf: boolean,
): string {
  if (!confirmTarget) return "";
  const { user, action } = confirmTarget;
  switch (action) {
    case "ban":
      return isSelf
        ? "You cannot disable your own account."
        : `${user.email} will be signed out everywhere and blocked from signing in again until unbanned.`;
    case "unban":
      return `${user.email} will be able to sign in again.`;
    case "revoke-sessions":
      return `${user.email} will be signed out everywhere and must sign in again.`;
    case "send-password-reset":
      return user.banned
        ? `This account is currently disabled — resetting the password will not re-enable sign-in. A reset email will be sent to ${user.email}.`
        : `A password reset email will be sent to ${user.email}.`;
    case "edit":
      return `Update details for ${user.email}.`;
    case "reset-mfa":
      return isSelf
        ? "You cannot reset your own MFA."
        : `Clear MFA configuration for ${user.email}. They will need to set it up again.`;
    case "assign-role":
      return `Update role for ${user.email}.`;
    case "move-tenant":
      return isSelf
        ? "You cannot move your own account."
        : `Move ${user.email} to another organization.`;
    case "delete":
      return isSelf
        ? "You cannot delete your own account."
        : `Soft-delete ${user.email}. They will be permanently removed from all organizations and disabled.`;
  }
}
