"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Input,
  Label,
  Badge,
  Field,
  Stack,
  Row,
  Can,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  PlatformIntegration,
  PlatformIntegrationCategory,
  TestPlatformIntegrationResponse,
} from "agora";
import { usePlatformPermissions } from "../../layout";

function ConnectionBadge({ status }: { status: PlatformIntegration["connectionStatus"] }) {
  if (status === "connected") return <Badge variant="success">Connected</Badge>;
  if (status === "error") return <Badge variant="warning">Error</Badge>;
  return <Badge variant="outline">Disconnected</Badge>;
}

export default function PlatformIntegrationDetailPage() {
  const params = useParams<{ category: string }>();
  // The API re-validates the category against the registry enum; the cast only
  // satisfies the typed client's param type for the URL segment.
  const category = params.category as PlatformIntegrationCategory;
  const permissions = usePlatformPermissions();

  const [it, setIt] = useState<PlatformIntegration | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState<string>("");
  const [secret, setSecret] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"].integrations[":category"].$get({
      param: { category },
    });
    if (!res.ok) {
      setError("Could not load this integration.");
      toast.error("Could not load this integration.");
      return;
    }
    const body = (await res.json()) as PlatformIntegration;
    setIt(body);
    setConfig({ ...body.config });
    setProvider(body.provider ?? "");
  }, [category]);

  useEffect(() => {
    load();
  }, [load]);

  async function mutate(json: Record<string, unknown>, okMessage: string) {
    setError(null);
    setPending(true);
    const res = await adminApi["rpc-admin"].integrations[":category"].$patch({
      param: { category },
      json,
    });
    setPending(false);
    if (res.ok) {
      const body = (await res.json()) as PlatformIntegration;
      setIt(body);
      setConfig({ ...body.config });
      setProvider(body.provider ?? "");
      setSecret("");
      toast.success(okMessage);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const errorMsg = body?.error ?? "The change could not be saved.";
    setError(errorMsg);
    toast.error(errorMsg);
  }

  async function runTest() {
    setError(null);
    setPending(true);
    const res = await adminApi["rpc-admin"].integrations[":category"].test.$post({
      param: { category },
    });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const errorMsg = body?.error ?? "The test could not run.";
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }
    const body = (await res.json()) as TestPlatformIntegrationResponse;
    if (!body.testable) {
      toast.success(body.message ?? "This integration has no automated connection test.");
    } else if (body.ok) {
      toast.success(body.message ?? "Connection succeeded.");
    } else {
      const errorMsg = body.message ?? "Connection failed.";
      setError(errorMsg);
      toast.error(errorMsg);
    }
    await load();
  }

  if (!it) {
    return (
      <Stack gap={6}>
        {!error && <p className="text-sm text-muted-foreground">Loading…</p>}
      </Stack>
    );
  }

  const canManage = (permissions.integration ?? []).includes("manage");

  return (
    <Stack gap={6}>
      <div>
        <Link href="/admin/integrations" className="text-sm text-muted-foreground">
          ← Integrations
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{it.label}</h1>
          <ConnectionBadge status={it.connectionStatus} />
          {it.enabled ? (
            <Badge variant="secondary">Enabled</Badge>
          ) : (
            <Badge variant="outline">Disabled</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{it.description}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Status and credential presence. Credentials are read from the environment or
            stored encrypted — never displayed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Row items="center" justify="between">
            <span className="text-sm text-muted-foreground">Credentials in environment</span>
            {it.hasCredentials ? (
              <Badge variant="secondary">Present</Badge>
            ) : (
              <Badge variant="outline">None</Badge>
            )}
          </Row>
          {it.acceptsSecret && (
            <Row items="center" justify="between">
              <span className="text-sm text-muted-foreground">Stored secret</span>
              {it.hasStoredSecret ? (
                <Badge variant="secondary">Stored</Badge>
              ) : (
                <Badge variant="outline">None</Badge>
              )}
            </Row>
          )}
          <Row items="center" justify="between">
            <span className="text-sm text-muted-foreground">Last successful connection</span>
            <span className="text-sm">
              {it.lastSuccessfulConnectionAt
                ? new Date(it.lastSuccessfulConnectionAt).toLocaleString()
                : "Never"}
            </span>
          </Row>
          {it.lastTestError && (
            <p className="text-xs text-destructive">Last error: {it.lastTestError}</p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Can permissions={permissions} resource="integration" action="test">
            <Button variant="outline" onClick={runTest} disabled={pending || !it.testable}>
              {it.testable ? "Test connection" : "Not testable"}
            </Button>
          </Can>
          <Can permissions={permissions} resource="integration" action="manage">
            {it.enabled ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" disabled={pending}>
                    Disconnect
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Disconnect {it.label}?</DialogTitle>
                    <DialogDescription>
                      This disables the {it.label} integration and marks it disconnected.
                      Its configuration and connection history are retained.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button
                        variant="destructive"
                        onClick={() =>
                          mutate({ action: "disconnect" }, `${it.label} disconnected.`)
                        }
                      >
                        Disconnect
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => mutate({ action: "connect", enabled: true }, `${it.label} enabled.`)}
              >
                Connect
              </Button>
            )}
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" disabled={pending}>
                  Reauthorize
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Reauthorize {it.label}?</DialogTitle>
                  <DialogDescription>
                    This clears the current connection state for {it.label}; run a test
                    afterward to re-establish it.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      onClick={() =>
                        mutate({ action: "reauthorize" }, `${it.label} reauthorization pending.`)
                      }
                    >
                      Reauthorize
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Can>
        </CardFooter>
      </Card>

      {(it.configFields.length > 0 || it.providers.length > 1 || it.acceptsSecret) && (
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Non-secret settings for this integration.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {it.providers.length > 1 && (
              <Field>
                <Label htmlFor="provider">Provider</Label>
                <Select value={provider} onValueChange={setProvider} disabled={!canManage}>
                  <SelectTrigger id="provider">
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {it.providers.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {it.configFields.map((f) => (
              <Field key={f.key}>
                <Label htmlFor={`cfg-${f.key}`}>
                  {f.label}
                  {f.optional ? "" : " *"}
                </Label>
                <Input
                  id={`cfg-${f.key}`}
                  value={config[f.key] ?? ""}
                  disabled={!canManage}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                />
              </Field>
            ))}
            {it.acceptsSecret && (
              <Field>
                <Label htmlFor="secret">
                  API key / secret ({it.hasStoredSecret ? "stored" : "none"})
                </Label>
                <Input
                  id="secret"
                  type="password"
                  value={secret}
                  disabled={!canManage}
                  placeholder={it.hasStoredSecret ? "Leave blank to keep the stored secret" : ""}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Write-only. The stored value is never displayed.
                </p>
              </Field>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Can permissions={permissions} resource="integration" action="manage">
              <Button
                disabled={pending}
                onClick={() => {
                  const json: Record<string, unknown> = { action: "configure", config };
                  if (it.providers.length > 1 && provider) json.provider = provider;
                  if (secret) json.secret = secret;
                  return mutate(json, "Configuration saved.");
                }}
              >
                Save configuration
              </Button>
              {it.acceptsSecret && it.hasStoredSecret && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => mutate({ clearSecret: true }, "Stored secret cleared.")}
                >
                  Clear stored secret
                </Button>
              )}
            </Can>
          </CardFooter>
        </Card>
      )}
    </Stack>
  );
}
