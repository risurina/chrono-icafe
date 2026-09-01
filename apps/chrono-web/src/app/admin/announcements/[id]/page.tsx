"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Label,
  Input,
  Textarea,
  Button,
  Badge,
  Stack,
  Row,
  toast,
  Can,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  Announcement,
  AnnouncementSeverity,
  AnnouncementType,
  AnnouncementChannel,
  AnnouncementTargeting,
  AnnouncementStats,
} from "agora";
import { usePlatformPermissions } from "../../layout";

const SEVERITY_VARIANT: Record<
  AnnouncementSeverity,
  "default" | "warning" | "secondary"
> = {
  critical: "default",
  warning: "warning",
  info: "secondary",
};

/** ISO string → value for a `datetime-local` input. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

export default function EditAnnouncementPage() {
  const permissions = usePlatformPermissions();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [message, setMessage] = useState("");
  const [type, setType] = useState<AnnouncementType>("system");
  const [targetingMode, setTargetingMode] =
    useState<AnnouncementTargeting["mode"]>("all");
  const [targetingTenantIds, setTargetingTenantIds] = useState("");
  const [targetingPlans, setTargetingPlans] = useState("");
  const [targetingRoles, setTargetingRoles] = useState("");
  const [targetingUserIds, setTargetingUserIds] = useState("");
  const [channels, setChannels] = useState<AnnouncementChannel[]>(["in_app"]);
  const [severity, setSeverity] = useState<AnnouncementSeverity>("info");
  const [startsAt, setStartsAt] = useState("");
  const [openEnded, setOpenEnded] = useState(true);
  const [endsAt, setEndsAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      const res = await adminApi["rpc-admin"].announcements[":id"].$get({
        param: { id },
      });
      if (signal.cancelled) return;
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        toast.error("Could not load this announcement.");
        return;
      }
      const a = (await res.json()) as Announcement;
      setAnnouncement(a);
      setMessage(a.message);
      setType(a.type);
      setChannels(a.channels);
      
      const tMode = a.targeting?.mode ?? "all";
      setTargetingMode(tMode);
      if (tMode === "tenants") {
        setTargetingTenantIds((a.targeting as any).tenantIds?.join(", ") ?? "");
      } else if (tMode === "plans") {
        setTargetingPlans((a.targeting as any).plans?.join(", ") ?? "");
      } else if (tMode === "roles") {
        setTargetingRoles((a.targeting as any).roles?.join(", ") ?? "");
      } else if (tMode === "users") {
        setTargetingUserIds((a.targeting as any).userIds?.join(", ") ?? "");
      }

      setSeverity(a.severity);
      setStartsAt(toLocalInput(a.startsAt));
      setOpenEnded(!a.endsAt);
      setEndsAt(a.endsAt ? toLocalInput(a.endsAt) : "");

      if (a.channels.length > 0) {
        const statsRes = await adminApi["rpc-admin"].announcements[":id"].stats.$get({ param: { id } });
        if (statsRes.ok) {
          const s = (await statsRes.json()) as AnnouncementStats;
          setStats(s);
        }
      }
    },
    [id],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  if (notFound) {
    return (
      <Stack gap={6}>
        <Link
          href="/admin/announcements"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Announcements
        </Link>
        <p className="text-sm text-muted-foreground">Announcement not found.</p>
      </Stack>
    );
  }

  if (!announcement) {
    return (
      <Stack gap={6}>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Stack>
    );
  }

  async function handleSave() {
    setSaving(true);
    const res = await adminApi["rpc-admin"].announcements[":id"].$patch({
      param: { id },
      json: {
        message,
        type,
        targeting:
          targetingMode === "all"
            ? { mode: "all" }
            : targetingMode === "tenants"
              ? {
                  mode: "tenants",
                  tenantIds: targetingTenantIds
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : targetingMode === "plans"
                ? {
                    mode: "plans",
                    plans: targetingPlans
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }
                : targetingMode === "roles"
                  ? {
                      mode: "roles",
                      roles: targetingRoles
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {
                      mode: "users",
                      userIds: targetingUserIds
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
        channels,
        severity,
        startsAt: toIso(startsAt),
        endsAt: openEnded ? null : (toIso(endsAt) ?? null),
      },
    });
    setSaving(false);
    if (res.ok) {
      const a = (await res.json()) as Announcement;
      setAnnouncement(a);
      toast.success("Announcement saved.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not save this announcement.");
  }

  async function handleRetire() {
    setRetiring(true);
    const res = await adminApi["rpc-admin"].announcements[":id"].retire.$post({
      param: { id },
    });
    setRetiring(false);
    if (res.ok) {
      const a = (await res.json()) as Announcement;
      setAnnouncement(a);
      setEndsAt(a.endsAt ? toLocalInput(a.endsAt) : "");
      setOpenEnded(!a.endsAt);
      toast.success("Announcement retired.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not retire this announcement.");
  }

  async function handleDelete() {
    setDeleting(true);
    const res = await adminApi["rpc-admin"].announcements[":id"].$delete({
      param: { id },
    });
    setDeleting(false);
    setConfirmDelete(false);
    if (res.ok) {
      router.push("/admin/announcements");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not delete this announcement.");
  }

  async function handleSend() {
    setSending(true);
    const res = await adminApi["rpc-admin"].announcements[":id"].send.$post({
      param: { id },
      json: { confirm: true },
    });
    setSending(false);
    setConfirmSend(false);
    if (res.ok) {
      toast.success("Announcement sent.");
      // Reload to pick up fresh emailSentAt / stats
      load({ cancelled: false });
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not send this announcement.");
  }

  const isLive =
    new Date(announcement.startsAt).getTime() <= Date.now() &&
    (!announcement.endsAt || new Date(announcement.endsAt).getTime() > Date.now());

  return (
    <Stack gap={6}>
      <div>
        <Link
          href="/admin/announcements"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Announcements
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Edit announcement</h1>
          <Badge variant={announcement.isActive ? "success" : "outline"}>
            {announcement.isActive ? "live" : "not live"}
          </Badge>
        </div>
        {announcement.createdByEmail ? (
          <p className="text-sm text-muted-foreground">
            Created by {announcement.createdByEmail}
          </p>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
            <CardDescription>
              Shown to every signed-in member on every tenant's dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!permissions.announcement?.includes("manage")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as AnnouncementType)}
                disabled={!permissions.announcement?.includes("manage")}
              >
                <SelectTrigger id="type" className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="security">Security</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                  <SelectItem value="billing">Billing</SelectItem>
                  <SelectItem value="feature">Feature</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="targetingMode">Targeting Mode</Label>
              <Select
                value={targetingMode}
                onValueChange={(v) =>
                  setTargetingMode(v as AnnouncementTargeting["mode"])
                }
                disabled={!permissions.announcement?.includes("manage")}
              >
                <SelectTrigger id="targetingMode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="tenants">Tenants</SelectItem>
                  <SelectItem value="plans">Plans</SelectItem>
                  <SelectItem value="roles">Roles</SelectItem>
                  <SelectItem value="users">Users</SelectItem>
                </SelectContent>
              </Select>
              {targetingMode === "tenants" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">Tenant IDs (comma-separated)</Label>
                  <Input
                    value={targetingTenantIds}
                    onChange={(e) => setTargetingTenantIds(e.target.value)}
                    disabled={!permissions.announcement?.includes("manage")}
                  />
                </div>
              )}
              {targetingMode === "plans" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">Plans (comma-separated)</Label>
                  <Input
                    value={targetingPlans}
                    onChange={(e) => setTargetingPlans(e.target.value)}
                    disabled={!permissions.announcement?.includes("manage")}
                  />
                </div>
              )}
              {targetingMode === "roles" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">Roles (comma-separated)</Label>
                  <Input
                    value={targetingRoles}
                    onChange={(e) => setTargetingRoles(e.target.value)}
                    disabled={!permissions.announcement?.includes("manage")}
                  />
                </div>
              )}
              {targetingMode === "users" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">User IDs (comma-separated)</Label>
                  <Input
                    value={targetingUserIds}
                    onChange={(e) => setTargetingUserIds(e.target.value)}
                    disabled={!permissions.announcement?.includes("manage")}
                  />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Channels</Label>
              <div className="flex flex-col gap-2 mt-2">
                <Row items="center" gap={2}>
                  {/* In-app is always on — it backs the dashboard banner and
                      is the one channel that is always deliverable. */}
                  <Switch checked disabled />
                  <Label className="font-normal cursor-pointer">In-app</Label>
                </Row>
                <Row items="center" gap={2}>
                  <Switch
                    checked={channels.includes("email")}
                    disabled={!permissions.announcement?.includes("manage")}
                    onCheckedChange={(c: boolean) => {
                      if (c) setChannels([...channels, "email"]);
                      else
                        setChannels(
                          channels.filter((ch: AnnouncementChannel) => ch !== "email"),
                        );
                    }}
                  />
                  <Label className="font-normal cursor-pointer">Email</Label>
                </Row>
                <Row items="center" gap={2}>
                  <Switch checked={false} disabled />
                  <Label className="font-normal text-muted-foreground">
                    SMS (Not yet deliverable)
                  </Label>
                </Row>
                <Row items="center" gap={2}>
                  <Switch checked={false} disabled />
                  <Label className="font-normal text-muted-foreground">
                    Push (Not yet deliverable)
                  </Label>
                </Row>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="severity">Severity</Label>
              <Select
                value={severity}
                onValueChange={(v) => setSeverity(v as AnnouncementSeverity)}
              >
                <SelectTrigger
                  id="severity"
                  className="w-[160px]"
                  disabled={!permissions.announcement?.includes("manage")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="startsAt">Starts at</Label>
              <Input
                id="startsAt"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                disabled={!permissions.announcement?.includes("manage")}
              />
            </div>
            <div className="space-y-2">
              <Row items="center" gap={2}>
                <Switch
                  id="openEnded"
                  checked={openEnded}
                  onCheckedChange={setOpenEnded}
                  aria-label="Open-ended"
                  disabled={!permissions.announcement?.includes("manage")}
                />
                <Label htmlFor="openEnded">Open-ended (retire manually)</Label>
              </Row>
              {!openEnded ? (
                <div className="space-y-2">
                  <Label htmlFor="endsAt">Ends at</Label>
                  <Input
                    id="endsAt"
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    disabled={!permissions.announcement?.includes("manage")}
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
          <CardFooter>
            <Can permissions={permissions} resource="announcement" action="manage">
              <Row gap={2}>
                <Button onClick={handleSave} disabled={saving || !message.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRetire}
                  disabled={retiring || !isLive}
                >
                  {retiring ? "Retiring…" : "Retire now"}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting}
                >
                  Delete
                </Button>
              </Row>
            </Can>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              What tenant members will see near the top of their dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {message.trim() ? (
              <Row
                items="center"
                justify="between"
                gap={4}
                className="w-full border-b px-4 py-2"
              >
                <Badge
                  variant={SEVERITY_VARIANT[severity]}
                  className="text-sm font-medium"
                >
                  {message}
                </Badge>
              </Row>
            ) : (
              <p className="text-sm text-muted-foreground">
                Enter a message to preview it.
              </p>
            )}
          </CardContent>
        </Card>

        {channels.includes("email") ? (
          <Card>
            <CardHeader>
              <CardTitle>Email Sending & Stats</CardTitle>
              <CardDescription>
                Send the announcement to the targeted email addresses.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Stack gap={4}>
                {!announcement.emailSentAt ? (
                  <p className="text-sm text-muted-foreground">
                    This announcement has not been sent via email yet. Note: save any message or targeting changes before sending.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Email sent on {new Date(announcement.emailSentAt).toLocaleString()}.
                  </p>
                )}
                {stats ? (
                  stats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No stats available.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      {stats.map((s) => (
                        <div key={s.channel} className="space-y-1 rounded border p-3">
                          <p className="text-sm font-medium capitalize">{s.channel}</p>
                          <div className="text-xs text-muted-foreground">
                            <div>Sent: {s.sent}</div>
                            <div>Read: {s.read}</div>
                            <div>Failed: {s.failed}</div>
                            <div>Skipped: {s.skipped}</div>
                            {s.unsupported !== undefined ? <div>Unsupported: {s.unsupported}</div> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : null}
              </Stack>
            </CardContent>
            <CardFooter>
              <Can permissions={permissions} resource="announcement" action="manage">
                <Button 
                  onClick={() => setConfirmSend(true)} 
                  disabled={!!announcement.emailSentAt || sending}
                >
                  Send Email
                </Button>
              </Can>
            </CardFooter>
          </Card>
        ) : null}
      </div>

      <Dialog open={confirmSend} onOpenChange={setConfirmSend}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send announcement via email?</DialogTitle>
            <DialogDescription>
              This will queue the email to be sent to all matching recipients based on current targeting. This cannot be undone. Make sure you have saved your recent changes first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSend(false)}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={sending}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this announcement?</DialogTitle>
            <DialogDescription>
              This permanently removes the row. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
