"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Switch,
  Badge,
  ListRow,
  Stack,
  toast,
  Can,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type { AuthProviderId, AuthProviderState } from "agora";
import { usePlatformPermissions } from "../layout";

export default function PlatformAuthProvidersPage() {
  const permissions = usePlatformPermissions();
  const [providers, setProviders] = useState<AuthProviderState[]>([]);
  const [pending, setPending] = useState<AuthProviderId | null>(null);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["auth-providers"].$get();
    if (!res.ok) {
      toast.error("Could not load sign-in methods.");
      return;
    }
    setProviders((await res.json()).providers as AuthProviderState[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The server is the authority on "at least one must remain" — this only stops
  // the obvious case reaching it, so the toggle reads as deliberate rather than
  // as a control that mysteriously fails.
  const availableCount = providers.filter((p) => p.available).length;

  /**
   * Why this row's toggle is inert, or null if it is usable. Note this blocks
   * only the direction the server would refuse: an unconfigured provider can
   * still be switched OFF, so an operator can record "we do not offer this"
   * rather than being stuck looking at an enabled-but-unavailable row.
   */
  function reasonToBlock(p: AuthProviderState, next: boolean): string | null {
    if (next && !p.configured)
      return "OAuth credentials are not configured for this provider.";
    if (!next && p.available && availableCount <= 1)
      return "This is the only sign-in method left — enable another one first.";
    return null;
  }

  async function toggle(p: AuthProviderState, enabled: boolean) {
    setPending(p.id);
    // Optimistic: reflect the new value while the request is in flight.
    setProviders((list) =>
      list.map((x) => (x.id === p.id ? { ...x, enabled } : x)),
    );
    const res = await adminApi["rpc-admin"]["auth-providers"][":id"].$patch({
      param: { id: p.id },
      json: { enabled },
    });
    setPending(null);
    if (res.ok) {
      setProviders((await res.json()).providers as AuthProviderState[]);
      toast.success(`${p.label} sign-in ${enabled ? "enabled" : "disabled"}.`);
      return;
    }
    // Show the server's own refusal text — it explains which invariant stopped
    // the change (last method, unconfigured, self-lockout).
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not update this sign-in method.");
    await load();
  }

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign-in methods</h1>
        <p className="text-sm text-muted-foreground">
          Which authentication methods the whole platform offers. At least one usable
          method must always remain enabled.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Staff authentication</CardTitle>
          <CardDescription>
            Applies to every workspace. Per-tenant enterprise SSO is configured
            separately, in each workspace&apos;s security settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sign-in methods are defined.
            </p>
          ) : (
            providers.map((p) => {
              // The toggle moves it to the opposite of its current flag.
              const blocked = reasonToBlock(p, !p.enabled);
              return (
                <ListRow
                  key={p.id}
                  actions={
                    <Can permissions={permissions} resource="authProvider" action="manage">
                      <Switch
                        checked={p.enabled}
                        disabled={pending === p.id || blocked !== null}
                        aria-label={`Toggle ${p.label} sign-in`}
                        onCheckedChange={(next) => toggle(p, next)}
                      />
                    </Can>
                  }
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{p.label}</p>
                      {p.available ? (
                        <Badge variant="secondary">Available</Badge>
                      ) : (
                        <Badge variant="outline">Unavailable</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                    {blocked ? (
                      <p className="mt-1 text-xs text-muted-foreground">{blocked}</p>
                    ) : null}
                  </div>
                </ListRow>
              );
            })
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
