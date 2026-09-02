"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Switch,
  Input,
  Label,
  Field,
  Button,
  buttonVariants,
  Badge,
  ListRow,
  Stack,
  Can,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformSetting,
  PlatformSettingsMirror,
  PlatformSettingValue,
  UpdatePlatformSettingsInput,
} from "agora";
import { usePlatformPermissions } from "../layout";

/**
 * Platform System Settings hub (`/admin/settings`, spec #14). Mirrors the
 * `/admin/security` + `/admin/auth-providers` page structure: Card + ListRow +
 * Switch/Input, `usePlatformPermissions()` gating every editable control via
 * `<Can resource="platformSettings" action="manage">`, optimistic-free save
 * with server-authoritative error text.
 *
 * General / Email / Storage / Maintenance / Danger-Zone are EDITABLE here (they
 * write the `platform_setting` KV store). Security / Authentication /
 * Notifications are SURFACED read-only with a "Manage" link — they keep their
 * own write path on their own pages, never a second one here.
 */

const SECTION_META: Record<
  string,
  { title: string; description: string }
> = {
  general: {
    title: "General",
    description: "Platform-wide identity and locale defaults.",
  },
  email: {
    title: "Email",
    description:
      "Default sender identity for platform email. Secrets (SMTP password) are never stored here — they stay in the environment.",
  },
  storage: {
    title: "Storage",
    description: "Default upload limits and accepted file types.",
  },
  maintenance: {
    title: "Maintenance",
    description:
      "Take tenant traffic offline for maintenance. The admin surface stays reachable so you can turn it back on.",
  },
  danger: {
    title: "Danger Zone",
    description:
      "Platform-wide switches with a broad blast radius. Each requires an explicit confirmation.",
  },
  retention: {
    title: "Retention",
    description:
      "How long finished job-queue rows and the platform audit log are kept before the daily retention sweep deletes them. Tenant audit log retention is set per subscription plan at /admin/plans instead.",
  },
};

const SECTION_ORDER = [
  "general",
  "email",
  "storage",
  "maintenance",
  "danger",
  "retention",
] as const;

/** How a stringList value renders in / reads out of a text input. */
function listToText(value: string[]): string {
  return value.join(", ");
}
function textToList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function PlatformSettingsPage() {
  const permissions = usePlatformPermissions();
  const canManage = (permissions.platformSettings ?? []).includes("manage");
  const [settings, setSettings] = useState<PlatformSetting[]>([]);
  const [mirror, setMirror] = useState<PlatformSettingsMirror | null>(null);
  // Local edit buffers for text/number/list controls, keyed by setting key.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // A pending critical toggle awaiting explicit confirmation.
  const [confirm, setConfirm] = useState<{
    setting: PlatformSetting;
    nextValue: boolean;
  } | null>(null);

  const applyDrafts = useCallback((list: PlatformSetting[]) => {
    const next: Record<string, string> = {};
    for (const s of list) {
      if (s.type === "stringList") next[s.key] = listToText(s.value as string[]);
      else if (s.type !== "boolean") next[s.key] = String(s.value);
    }
    setDrafts(next);
  }, []);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"].settings.$get();
    if (!res.ok) {
      toast.error("Could not load system settings.");
      return;
    }
    const body = await res.json();
    setSettings(body.settings as PlatformSetting[]);
    setMirror(body.mirror as PlatformSettingsMirror);
    applyDrafts(body.settings as PlatformSetting[]);
  }, [applyDrafts]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(key: string, value: PlatformSettingValue) {
    setBusyKey(key);
    const res = await adminApi["rpc-admin"].settings.$patch({
      json: { [key]: value } as UpdatePlatformSettingsInput,
    });
    setBusyKey(null);
    if (res.ok) {
      const body = await res.json();
      setSettings(body.settings as PlatformSetting[]);
      setMirror(body.mirror as PlatformSettingsMirror);
      applyDrafts(body.settings as PlatformSetting[]);
      toast.success("Setting saved.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not save this setting.");
    await load();
  }

  function onToggle(setting: PlatformSetting, next: boolean) {
    if (setting.critical) {
      // Danger-Zone / Maintenance toggles name their platform-wide blast radius
      // before the write fires.
      setConfirm({ setting, nextValue: next });
      return;
    }
    void save(setting.key, next);
  }

  function saveDraft(setting: PlatformSetting) {
    const raw = drafts[setting.key] ?? "";
    const value: PlatformSettingValue =
      setting.type === "number"
        ? Number(raw)
        : setting.type === "stringList"
          ? textToList(raw)
          : raw;
    if (setting.type === "number" && Number.isNaN(value as number)) {
      toast.error(`${setting.label} must be a number.`);
      return;
    }
    void save(setting.key, value);
  }

  const bySection = (section: string) =>
    settings.filter((s) => s.section === section);

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System settings</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide configuration. Security, sign-in methods, and notifications
          are managed on their own pages and surfaced read-only below.
        </p>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="danger">Danger Zone</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="authentication">Authentication</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        {SECTION_ORDER.map((section) => {
          const items = bySection(section);
          if (items.length === 0) return null;
          const meta = SECTION_META[section]!;
          return (
            <TabsContent key={section} value={section}>
              <Card>
            <CardHeader>
              <CardTitle>{meta.title}</CardTitle>
              <CardDescription>{meta.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((s) =>
                s.type === "boolean" ? (
                  <ListRow
                    key={s.key}
                    actions={
                      <Can
                        permissions={permissions}
                        resource="platformSettings"
                        action="manage"
                      >
                        <Switch
                          checked={s.value === true}
                          disabled={busyKey === s.key}
                          aria-label={`Toggle ${s.label}`}
                          onCheckedChange={(next) => onToggle(s, next)}
                        />
                      </Can>
                    }
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{s.label}</p>
                        {s.critical ? <Badge variant="outline">Critical</Badge> : null}
                        {s.value === true ? <Badge variant="secondary">On</Badge> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">{s.description}</p>
                    </div>
                  </ListRow>
                ) : (
                  <div key={s.key}>
                    <Can
                      permissions={permissions}
                      resource="platformSettings"
                      action="manage"
                    >
                      <Field>
                        <Label htmlFor={s.key}>{s.label}</Label>
                        <div className="flex gap-2">
                          <Input
                            id={s.key}
                            inputMode={s.type === "number" ? "numeric" : undefined}
                            value={drafts[s.key] ?? ""}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [s.key]: e.target.value }))
                            }
                            disabled={busyKey === s.key}
                          />
                          <Button
                            type="button"
                            disabled={busyKey === s.key}
                            onClick={() => saveDraft(s)}
                          >
                            Save
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{s.description}</p>
                      </Field>
                    </Can>
                    {!canManage ? (
                      <div>
                        <p className="text-sm font-medium">{s.label}</p>
                        <p className="text-sm text-muted-foreground">
                          {s.type === "stringList"
                            ? listToText(s.value as string[]) || "—"
                            : String(s.value) || "—"}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ),
              )}
            </CardContent>
              </Card>
            </TabsContent>
          );
        })}

        {/* ── Surfaced sections: read-only mirror + Manage link, no second write path ── */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
          <CardDescription>
            Two-factor and session-age hardening for platform-role accounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <ListRow>
            <div className="min-w-0">
              <p className="text-sm font-medium">Require 2FA</p>
              <p className="text-xs text-muted-foreground">
                {mirror?.security.twoFactorRequired ? "Required" : "Not required"}
              </p>
            </div>
          </ListRow>
          <ListRow>
            <div className="min-w-0">
              <p className="text-sm font-medium">Session age limit</p>
              <p className="text-xs text-muted-foreground">
                {mirror?.security.sessionMaxAgeMinutes != null
                  ? `${mirror.security.sessionMaxAgeMinutes} minutes`
                  : "No override"}
              </p>
            </div>
          </ListRow>
        </CardContent>
            <CardFooter>
              <Link href="/admin/security" className={buttonVariants({ variant: "outline" })}>
                Manage security
              </Link>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="authentication">
          <Card>
            <CardHeader>
              <CardTitle>Authentication</CardTitle>
          <CardDescription>
            Platform-wide sign-in methods available to staff.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(mirror?.authProviders ?? []).map((p) => (
            <ListRow
              key={p.id}
              actions={
                p.available ? (
                  <Badge variant="secondary">Available</Badge>
                ) : (
                  <Badge variant="outline">Unavailable</Badge>
                )
              }
            >
              <p className="text-sm font-medium">{p.label}</p>
            </ListRow>
          ))}
        </CardContent>
            <CardFooter>
              <Link
                href="/admin/auth-providers"
                className={buttonVariants({ variant: "outline" })}
              >
                Manage sign-in methods
              </Link>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Staff/account notification email templates.
          </CardDescription>
        </CardHeader>
            <CardFooter>
              <Link
                href="/admin/notifications"
                className={buttonVariants({ variant: "outline" })}
              >
                Manage notifications
              </Link>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.nextValue ? "Turn on" : "Turn off"} {confirm?.setting.label}?
            </DialogTitle>
            <DialogDescription>
              This affects every business on the platform. {confirm?.setting.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.nextValue ? "destructive" : "default"}
              onClick={() => {
                if (!confirm) return;
                const { setting, nextValue } = confirm;
                setConfirm(null);
                void save(setting.key, nextValue);
              }}
            >
              {confirm?.nextValue ? "Turn on" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
