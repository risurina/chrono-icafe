"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  Announcement,
  AnnouncementSeverity,
  AnnouncementType,
  AnnouncementChannel,
  AnnouncementTargeting,
} from "agora";

const SEVERITY_VARIANT: Record<
  AnnouncementSeverity,
  "default" | "warning" | "secondary"
> = {
  critical: "default",
  warning: "warning",
  info: "secondary",
};

/** Local `datetime-local` value → ISO string, or undefined if empty. */
function toIso(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

export default function NewAnnouncementPage() {
  const router = useRouter();
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

  async function handleSave() {
    setSaving(true);
    const res = await adminApi["rpc-admin"].announcements.$post({
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
        endsAt: openEnded ? null : toIso(endsAt),
      },
    });
    setSaving(false);
    if (res.ok) {
      const created = (await res.json()) as Announcement;
      router.push(`/admin/announcements/${created.id}`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not create this announcement.");
  }

  return (
    <Stack gap={6}>
      <div>
        <Link
          href="/admin/announcements"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Announcements
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New announcement</h1>
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
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as AnnouncementType)}
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
                  />
                </div>
              )}
              {targetingMode === "plans" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">Plans (comma-separated)</Label>
                  <Input
                    value={targetingPlans}
                    onChange={(e) => setTargetingPlans(e.target.value)}
                  />
                </div>
              )}
              {targetingMode === "roles" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">Roles (comma-separated)</Label>
                  <Input
                    value={targetingRoles}
                    onChange={(e) => setTargetingRoles(e.target.value)}
                  />
                </div>
              )}
              {targetingMode === "users" && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs">User IDs (comma-separated)</Label>
                  <Input
                    value={targetingUserIds}
                    onChange={(e) => setTargetingUserIds(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Channels</Label>
              <div className="flex flex-col gap-2 mt-2">
                <Row items="center" gap={2}>
                  <Switch checked={channels.includes("in_app")} disabled />
                  <Label className="font-normal cursor-pointer">In-app</Label>
                </Row>
                <Row items="center" gap={2}>
                  <Switch
                    checked={channels.includes("email")}
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
                <SelectTrigger id="severity" className="w-[160px]">
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
              <Label htmlFor="startsAt">Starts at (leave blank for now)</Label>
              <Input
                id="startsAt"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Row items="center" gap={2}>
                <Switch
                  id="openEnded"
                  checked={openEnded}
                  onCheckedChange={setOpenEnded}
                  aria-label="Open-ended"
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
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleSave} disabled={saving || !message.trim()}>
              {saving ? "Creating…" : "Create announcement"}
            </Button>
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
      </div>
    </Stack>
  );
}
