"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  ListRow,
  Stack,
  Can,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { NotificationTemplateState } from "agora";
import { usePlatformPermissions } from "../layout";

/**
 * Low-cardinality, platform-wide resource (exactly three keys today) — a
 * backend list contract would be pure overhead, so this loads the whole list
 * once, per `.ai/rules/data-listing.md`'s client-side-pagination allowance.
 */
export default function NotificationTemplatesPage() {
  const permissions = usePlatformPermissions();
  const [templates, setTemplates] = useState<NotificationTemplateState[]>([]);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["notification-templates"].$get();
    if (!res.ok) {
      toast.error("Could not load notification templates.");
      return;
    }
    setTemplates((await res.json()).templates as NotificationTemplateState[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Notification templates
        </h1>
        <p className="text-sm text-muted-foreground">
          Applies to staff/account-holder emails only — password reset, email
          verification, and organization invites. Does not affect tenant customer
          password-reset emails, which are a separate, tenant-facing surface.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Platform email content</CardTitle>
          <CardDescription>
            One override per key, platform-wide. A key with no saved override keeps
            sending its built-in default content.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            templates.map((t) => (
              <ListRow
                key={t.key}
                actions={
                  <Can permissions={permissions} resource="notification" action="read">
                    <Link href={`/admin/notifications/${t.key}`}>
                      <Button variant="outline" size="sm">
                        Edit
                      </Button>
                    </Link>
                  </Can>
                }
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{t.label}</p>
                    {t.isOverridden ? (
                      <Badge variant="secondary">Customized</Badge>
                    ) : (
                      <Badge variant="outline">Default</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                  {t.isOverridden && t.updatedAt ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last updated {new Date(t.updatedAt).toLocaleString()}
                      {t.updatedByEmail ? ` by ${t.updatedByEmail}` : ""}
                    </p>
                  ) : null}
                </div>
              </ListRow>
            ))
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
