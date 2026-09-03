"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Switch,
  Input,
  Label,
  Field,
  Button,
  ListRow,
  Stack,
  Can,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { PlatformSecurityPolicy } from "agora";
import { usePlatformPermissions } from "../layout";

/**
 * Platform-wide security policy settings (`/admin/security`). Mirrors the
 * `/admin/auth-providers` page structure: Card + ListRow + Switch/Input,
 * `usePlatformPermissions()` gating the manage controls, optimistic update +
 * server-authoritative error text — including the blocking-accounts list
 * from the 2FA all-admins guard's 400 response.
 */
export default function PlatformSecurityPage() {
  const permissions = usePlatformPermissions();
  const canManage = (permissions.platformSecurity ?? []).includes("manage");
  const [policy, setPolicy] = useState<PlatformSecurityPolicy | null>(null);
  const [sessionMaxAgeInput, setSessionMaxAgeInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["security-policy"].$get();
    if (!res.ok) {
      toast.error("Could not load the security policy.");
      return;
    }
    const body = (await res.json()) as PlatformSecurityPolicy;
    setPolicy(body);
    setSessionMaxAgeInput(
      body.sessionMaxAgeMinutes != null ? String(body.sessionMaxAgeMinutes) : "",
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: { twoFactorRequired?: boolean; sessionMaxAgeMinutes?: number | null }) {
    setBusy(true);
    const res = await adminApi["rpc-admin"]["security-policy"].$patch({ json: body });
    setBusy(false);
    if (res.ok) {
      const next = (await res.json()) as PlatformSecurityPolicy;
      setPolicy(next);
      setSessionMaxAgeInput(
        next.sessionMaxAgeMinutes != null ? String(next.sessionMaxAgeMinutes) : "",
      );
      toast.success("Security policy updated.");
      return;
    }
    const responseBody = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(responseBody?.error ?? "Could not update the security policy.");
    await load();
  }

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide hardening for accounts holding a platform role. These are
          floors, not conveniences — they affect every current admin session,
          including your own.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            Require TOTP enrollment for every platform-role account before it can
            use the platform admin surface. Refused if any platform-role holder
            is neither enrolled nor able to enroll.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <ListRow
            actions={
              <Can permissions={permissions} resource="platformSecurity" action="manage">
                <Switch
                  checked={policy?.twoFactorRequired ?? false}
                  disabled={busy || policy === null}
                  aria-label="Require 2FA for platform admins"
                  onCheckedChange={(next) => patch({ twoFactorRequired: next })}
                />
              </Can>
            }
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Require 2FA</p>
              <p className="text-xs text-muted-foreground">
                Not enrolled yet?{" "}
                <Link href="/admin/security/mfa" className="text-primary hover:underline">
                  Enroll here
                </Link>
                .
              </p>
            </div>
          </ListRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session age limit</CardTitle>
          <CardDescription>
            Absolute ceiling (30 minutes – 7 days) on how long a platform-admin
            session stays valid, measured from sign-in — not idle time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Can permissions={permissions} resource="platformSecurity" action="manage">
            <Field>
              <Label htmlFor="sessionMaxAge">Minutes (blank = no override)</Label>
              <div className="flex gap-2">
                <Input
                  id="sessionMaxAge"
                  inputMode="numeric"
                  placeholder="e.g. 480"
                  value={sessionMaxAgeInput}
                  onChange={(e) => setSessionMaxAgeInput(e.target.value)}
                  disabled={busy}
                />
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    patch({
                      sessionMaxAgeMinutes:
                        sessionMaxAgeInput.trim() === ""
                          ? null
                          : Number(sessionMaxAgeInput),
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </Field>
          </Can>
          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              Current value:{" "}
              {policy?.sessionMaxAgeMinutes != null
                ? `${policy.sessionMaxAgeMinutes} minutes`
                : "no override"}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Stack>
  );
}
