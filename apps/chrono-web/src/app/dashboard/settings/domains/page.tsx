"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Stack,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  useClientListPage,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { Domain } from "agora";

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [hostname, setHostname] = useState("");
  const [method, setMethod] = useState<"txt" | "cname">("txt");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const query = useListQuery();
  // Client-side pagination: custom domains are a low-cardinality, per-tenant
  // resource — a backend list contract would be pure overhead, per
  // .ai/rules/data-listing.md.
  const { items: pagedDomains, meta } = useClientListPage(
    domains,
    query,
    (d) => [d.hostname],
  );

  const load = useCallback(async () => {
    const res = await api.rpc.domains.$get();
    if (res.ok) setDomains((await res.json()).domains as Domain[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.domains.$post({ json: { hostname, method } });
    setBusy(false);
    if (res.ok) {
      setHostname("");
      setMsg("Domain added. Create the DNS record below, then click Verify.");
      load();
    } else if ((res.status as number) === 403) {
      setForbidden(true);
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(body.error ?? "Could not add domain.");
    }
  }

  async function verify(id: string) {
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.domains[":id"].verify.$post({ param: { id } });
    setBusy(false);
    if (res.ok) {
      const body = await res.json();
      setMsg(
        body.verified
          ? "Domain verified — it now routes to this workspace."
          : "DNS record not found yet. It can take a while to propagate; try again shortly.",
      );
      load();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(body.error ?? "Verification failed.");
    }
  }

  async function setPrimary(id: string) {
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.domains[":id"].primary.$post({ param: { id } });
    setBusy(false);
    if (res.ok) load();
    else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(body.error ?? "Could not set primary.");
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setMsg(null);
    const res = await api.rpc.domains[":id"].$delete({ param: { id } });
    setBusy(false);
    if (res.ok) load();
    else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(body.error ?? "Could not remove domain.");
    }
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Custom domains are managed by admins and owners only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Custom Domains</h1>
        <p className="text-sm text-muted-foreground">
          Serve this workspace on your own domain (e.g. app.yourcompany.com). Prove
          ownership with a DNS record; TLS is provisioned automatically.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Add a domain</CardTitle>
          <CardDescription>
            Choose how you&apos;ll prove ownership: a TXT record (recommended) or a
            CNAME.
          </CardDescription>
        </CardHeader>
        <form onSubmit={add}>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <Field>
                <Label htmlFor="hostname">Hostname</Label>
                <Input
                  id="hostname"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="app.yourcompany.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </Field>
              <Field>
                <Label htmlFor="method">Method</Label>
                <Select
                  value={method}
                  onValueChange={(v) => setMethod(v as "txt" | "cname")}
                >
                  <SelectTrigger id="method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="txt">DNS TXT</SelectItem>
                    <SelectItem value="cname">CNAME</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={busy || hostname.trim() === ""}>
              {busy ? "Working…" : "Add domain"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your domains</CardTitle>
          <CardDescription>
            A domain routes to this workspace only after it&apos;s verified.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search domains…"
            view={query.view}
            onViewChange={query.setView}
          />

          {(() => {
            const renderActions = (d: Domain) => (
              <>
                {!d.verifiedAt ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => verify(d.id)}
                  >
                    Verify
                  </Button>
                ) : !d.isPrimary ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPrimary(d.id)}
                  >
                    Set primary
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => remove(d.id)}
                >
                  Remove
                </Button>
              </>
            );

            const columns: DataTableColumn<Domain>[] = [
              { key: "hostname", header: "Hostname" },
              {
                key: "status",
                header: "Status",
                render: (d) => (
                  <>
                    {d.verifiedAt ? (
                      <Badge variant="default">Verified</Badge>
                    ) : (
                      <Badge variant="secondary">Pending</Badge>
                    )}
                    {d.isPrimary ? (
                      <Badge variant="outline" className="ml-2">
                        Primary
                      </Badge>
                    ) : null}
                  </>
                ),
              },
              {
                key: "record",
                header: "DNS record",
                render: (d) =>
                  d.record ? (
                    <code className="break-all text-xs text-muted-foreground">
                      {d.record.type} {d.record.name} → {d.record.value}
                    </code>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                key: "actions",
                header: "",
                render: (d) => <div className="space-x-2 text-right">{renderActions(d)}</div>,
              },
            ];

            return query.view === "grid" ? (
              <DataTableGrid
                rows={pagedDomains}
                rowKey={(d) => d.id}
                emptyMessage="No custom domains yet."
                renderCard={(d) => (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{d.hostname}</p>
                      {d.verifiedAt ? (
                        <Badge variant="default">Verified</Badge>
                      ) : (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                    </div>
                    <div className="space-x-2">{renderActions(d)}</div>
                  </div>
                )}
              />
            ) : (
              <DataTable
                columns={columns}
                rows={pagedDomains}
                rowKey={(d) => d.id}
                emptyMessage="No custom domains yet."
              />
            );
          })()}

          <DataTablePagination
            meta={meta}
            onPageChange={query.setPage}
            onPageSizeChange={query.setPageSize}
          />
        </CardContent>
      </Card>
    </Stack>
  );
}
