"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
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
  Can,
  Label,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { useSession } from "@/lib/auth-client";
import { usePlatformPermissions } from "../layout";
import type {
  PlatformRole,
  PlatformStaffSummary,
  PlatformAuditEvent,
  PlatformCustomRole,
} from "agora";

// Mirrors PLATFORM_ROLE_KEYS (packages/agora/src/auth/platform-permissions.ts) —
// hardcoded here rather than imported, since "agora/auth" pulls server-only
// Better Auth config into the client bundle (see .ai/rules/architecture.md).
const PLATFORM_ROLE_KEYS: PlatformRole[] = ["viewer", "support", "admin"];
const ROLE_BADGE_VARIANT: Record<PlatformRole, "default" | "secondary"> = {
  admin: "default",
  support: "secondary",
  viewer: "secondary",
};

type MutatingAction =
  // `role` is a system role OR a custom-role key (a string), or null to revoke.
  | { kind: "role"; role: string | null }
  | { kind: "disable" }
  | { kind: "enable" }
  | { kind: "revoke-sessions" }
  | { kind: "reset-mfa" };

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Administrator management: the platform-role holders, enriched with status /
 * MFA / last login / last activity, plus invite-by-email and per-account
 * actions (role change, disable/enable, revoke sessions, reset MFA, activity).
 * Low-cardinality, platform-wide resource (staff accounts, not tenants) — a
 * backend list contract would be pure overhead, so this loads the whole list
 * once, per `.ai/rules/data-listing.md`'s client-side-pagination allowance.
 */
export default function PlatformStaffPage() {
  const permissions = usePlatformPermissions();
  const { data: session } = useSession();
  const [items, setItems] = useState<PlatformStaffSummary[]>([]);
  const [customRoles, setCustomRoles] = useState<PlatformCustomRole[]>([]);

  const [manageTarget, setManageTarget] = useState<PlatformStaffSummary | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    account: PlatformStaffSummary;
    action: MutatingAction;
  } | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<PlatformRole>("viewer");

  const [activityTarget, setActivityTarget] = useState<PlatformStaffSummary | null>(null);
  const [activityItems, setActivityItems] = useState<PlatformAuditEvent[] | null>(null);

  const load = useCallback(async () => {
    const [res, rolesRes] = await Promise.all([
      adminApi["rpc-admin"].staff.$get(),
      adminApi["rpc-admin"].staff.roles.$get(),
    ]);
    if (!res.ok) {
      toast.error("Could not load administrator accounts.");
      return;
    }
    const body = await res.json();
    setItems(body.items as PlatformStaffSummary[]);
    if (rolesRes.ok) setCustomRoles((await rolesRes.json()).items as PlatformCustomRole[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function performAction() {
    if (!confirmTarget) return;
    const { account, action } = confirmTarget;

    let res: Response;
    if (action.kind === "role") {
      res = await adminApi["rpc-admin"].staff[":userId"].role.$patch({
        param: { userId: account.userId },
        json: { role: action.role },
      });
    } else if (action.kind === "disable") {
      res = await adminApi["rpc-admin"].users[":userId"].ban.$patch({
        param: { userId: account.userId },
        json: { banReason: "Disabled from administrator management." },
      });
    } else if (action.kind === "enable") {
      res = await adminApi["rpc-admin"].users[":userId"].unban.$patch({
        param: { userId: account.userId },
      });
    } else if (action.kind === "revoke-sessions") {
      res = await adminApi["rpc-admin"].users[":userId"]["revoke-sessions"].$post({
        param: { userId: account.userId },
      });
    } else {
      res = await adminApi["rpc-admin"].users[":userId"]["reset-mfa"].$post({
        param: { userId: account.userId },
      });
    }

    setConfirmTarget(null);
    setManageTarget(null);
    if (res.ok) {
      toast.success(actionSuccess(account.email, action));
      load();
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not complete this action.");
    }
  }

  async function submitInvite() {
    const res = await adminApi["rpc-admin"].staff.invite.$post({
      json: { email: inviteEmail.trim(), name: inviteName.trim(), role: inviteRole },
    });
    if (res.ok) {
      const body = (await res.json()) as { createdUser: boolean; email: string };
      toast.success(
        body.createdUser
          ? `Invited ${body.email} — a set-password email was sent.`
          : `${body.email} was granted the ${inviteRole} platform role.`,
      );
      setInviteOpen(false);
      setInviteEmail("");
      setInviteName("");
      setInviteRole("viewer");
      load();
    } else if (res.status === 429) {
      toast.error("Too many actions. Try again later.");
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not invite this administrator.");
    }
  }

  async function openActivity(account: PlatformStaffSummary) {
    setActivityTarget(account);
    setActivityItems(null);
    const res = await adminApi["rpc-admin"].staff[":userId"].activity.$get({
      param: { userId: account.userId },
    });
    if (res.ok) {
      const body = await res.json();
      setActivityItems(body.items as PlatformAuditEvent[]);
    } else {
      setActivityItems([]);
    }
  }

  const isSelfManage = manageTarget?.userId === session?.user.id;

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administrators</h1>
        <p className="text-sm text-muted-foreground">
          Accounts holding a platform role. Invite by email, change roles, and manage
          access. At least one active admin must always remain.
        </p>
      </div>

      <Card>
        <CardHeader>
          <Row gap={2} className="items-center justify-between">
            <Stack gap={1}>
              <CardTitle>Platform accounts</CardTitle>
              <CardDescription>
                &quot;admin&quot; holds every platform action; &quot;support&quot; can look
                and link/update support tickets; &quot;viewer&quot; can only look. MFA for
                all administrators is governed by the platform{" "}
                <Link href="/admin/security" className="underline">
                  security policy
                </Link>
                .
              </CardDescription>
            </Stack>
            <Can permissions={permissions} resource="staff" action="manage">
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                Invite administrator
              </Button>
            </Can>
          </Row>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>MFA</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((account) => (
                <TableRow key={account.userId}>
                  <TableCell>{account.name}</TableCell>
                  <TableCell>{account.email}</TableCell>
                  <TableCell>
                    <Badge variant={ROLE_BADGE_VARIANT[account.platformRole]}>
                      {account.platformRole}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={account.status === "disabled" ? "warning" : "success"}>
                      {account.status === "disabled" ? "Disabled" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={account.mfaEnabled ? "success" : "secondary"}>
                      {account.mfaEnabled ? "On" : "Off"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmt(account.lastActiveAt)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmt(account.lastActivityAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setManageTarget(account)}
                    >
                      Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Per-account actions */}
      <Dialog
        open={manageTarget !== null}
        onOpenChange={(open) => !open && setManageTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{manageTarget?.email}</DialogTitle>
            <DialogDescription>
              Manage this administrator&apos;s platform access.
            </DialogDescription>
          </DialogHeader>
          {manageTarget ? (
            <Stack gap={4}>
              <Row gap={2} wrap>
                <Badge variant={ROLE_BADGE_VARIANT[manageTarget.platformRole]}>
                  {manageTarget.platformRole}
                </Badge>
                <Badge variant={manageTarget.status === "disabled" ? "warning" : "success"}>
                  {manageTarget.status === "disabled" ? "Disabled" : "Active"}
                </Badge>
                <Badge variant={manageTarget.mfaEnabled ? "success" : "secondary"}>
                  MFA {manageTarget.mfaEnabled ? "on" : "off"}
                </Badge>
              </Row>

              <Can permissions={permissions} resource="staff" action="manage">
                <Stack gap={2}>
                  <Label>Change role</Label>
                  <Select
                    value={manageTarget.platformRole}
                    onValueChange={(value) =>
                      setConfirmTarget({
                        account: manageTarget,
                        action: { kind: "role", role: value },
                      })
                    }
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_ROLE_KEYS.map((role) => (
                        <SelectItem key={role} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                      {customRoles.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Stack>
              </Can>

              <Row gap={2} wrap>
                <Can permissions={permissions} resource="staff" action="manage">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setConfirmTarget({
                        account: manageTarget,
                        action: { kind: "role", role: null },
                      })
                    }
                  >
                    Revoke access
                  </Button>
                </Can>
                <Can permissions={permissions} resource="user" action="disable">
                  {manageTarget.status === "disabled" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setConfirmTarget({
                          account: manageTarget,
                          action: { kind: "enable" },
                        })
                      }
                    >
                      Enable
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={manageTarget.userId === session?.user.id}
                      onClick={() =>
                        setConfirmTarget({
                          account: manageTarget,
                          action: { kind: "disable" },
                        })
                      }
                    >
                      Disable
                    </Button>
                  )}
                </Can>
                <Can permissions={permissions} resource="user" action="resetSessions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setConfirmTarget({
                        account: manageTarget,
                        action: { kind: "revoke-sessions" },
                      })
                    }
                  >
                    Revoke sessions
                  </Button>
                </Can>
                <Can permissions={permissions} resource="user" action="resetMfa">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !manageTarget.mfaEnabled ||
                      manageTarget.userId === session?.user.id
                    }
                    onClick={() =>
                      setConfirmTarget({
                        account: manageTarget,
                        action: { kind: "reset-mfa" },
                      })
                    }
                  >
                    Reset MFA
                  </Button>
                </Can>
                <Button variant="outline" size="sm" onClick={() => openActivity(manageTarget)}>
                  View activity
                </Button>
              </Row>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Confirm a mutating action */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTitle(confirmTarget?.action)}</DialogTitle>
            <DialogDescription>
              {confirmDescription(confirmTarget, isSelfManage)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button onClick={performAction}>Confirm</Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite an administrator */}
      <Dialog open={inviteOpen} onOpenChange={(open) => !open && setInviteOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite an administrator</DialogTitle>
            <DialogDescription>
              Grants a platform role to an existing account, or creates a new account and
              emails a set-password link.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={4}>
            <Stack gap={2}>
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="admin@example.com"
              />
            </Stack>
            <Stack gap={2}>
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Full name"
              />
            </Stack>
            <Stack gap={2}>
              <Label>Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => setInviteRole(value as PlatformRole)}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_ROLE_KEYS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Stack>
          </Stack>
          <DialogFooter>
            <Row gap={2}>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={submitInvite}
                disabled={inviteEmail.trim().length === 0 || inviteName.trim().length === 0}
              >
                Send invite
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Administrator activity */}
      <Dialog
        open={activityTarget !== null}
        onOpenChange={(open) => !open && setActivityTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recent activity</DialogTitle>
            <DialogDescription>
              {activityTarget?.email}&apos;s most recent platform actions.
            </DialogDescription>
          </DialogHeader>
          {activityItems === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : activityItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recorded activity.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activityItems.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="text-sm">{ev.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {ev.targetLabel ?? ev.targetType ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmt(ev.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

function actionSuccess(email: string, action: MutatingAction): string {
  switch (action.kind) {
    case "role":
      return action.role
        ? `${email} is now a platform ${action.role}.`
        : `${email}'s platform access was revoked.`;
    case "disable":
      return `${email} was disabled.`;
    case "enable":
      return `${email} was re-enabled.`;
    case "revoke-sessions":
      return `${email}'s sessions were revoked.`;
    case "reset-mfa":
      return `${email}'s MFA was reset.`;
  }
}

function confirmTitle(action: MutatingAction | undefined): string {
  if (!action) return "";
  switch (action.kind) {
    case "role":
      return action.role === null
        ? "Revoke platform access?"
        : `Set role to "${action.role}"?`;
    case "disable":
      return "Disable administrator?";
    case "enable":
      return "Re-enable administrator?";
    case "revoke-sessions":
      return "Revoke all sessions?";
    case "reset-mfa":
      return "Reset MFA?";
  }
}

function confirmDescription(
  target: { account: PlatformStaffSummary; action: MutatingAction } | null,
  isSelf: boolean,
): string {
  if (!target) return "";
  const { account, action } = target;
  switch (action.kind) {
    case "role":
      return isSelf
        ? "You are changing your own platform access. If this removes your admin access, you will lose the ability to manage administrators yourself."
        : `This changes ${account.email}'s platform role.`;
    case "disable":
      return `${account.email} will be signed out everywhere and blocked from signing in until re-enabled. Disabling the last active admin is refused.`;
    case "enable":
      return `${account.email} will be able to sign in again.`;
    case "revoke-sessions":
      return `${account.email} will be signed out everywhere and must sign in again.`;
    case "reset-mfa":
      return `${account.email}'s enrolled TOTP will be cleared and their sessions revoked. They must re-enroll. Refused while platform-wide MFA is required.`;
  }
}
