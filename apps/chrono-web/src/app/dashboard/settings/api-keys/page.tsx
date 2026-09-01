"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Stack,
  Row,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  useClientListPage,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { ApiKey, ApiKeyCreated } from "agora";

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const query = useListQuery();
  // Client-side pagination: API keys are a low-cardinality, per-tenant resource
  // (typically single-digit rows) — a backend list contract would be pure
  // overhead, per .ai/rules/data-listing.md.
  const { items: pagedKeys, meta } = useClientListPage(
    keys,
    query,
    (k) => [k.name, k.prefix],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.rpc["api-keys"].$get();
    setLoading(false);
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setKeys((await res.json()).keys as ApiKey[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setCreated(null);
    setCopied(false);
    setCreating(true);
    const res = await api.rpc["api-keys"].$post({ json: { name, role: "admin" } });
    setCreating(false);
    if (res.ok) {
      const body = (await res.json()) as { apiKey: ApiKeyCreated };
      setCreated(body.apiKey);
      setName("");
      load();
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can create API keys.");
    } else {
      setMsg("Could not create the API key.");
    }
  }

  async function revoke(id: string) {
    setMsg(null);
    const res = await api.rpc["api-keys"][":id"].$delete({ param: { id } });
    if (res.ok) {
      setMsg("API key revoked.");
      load();
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can revoke API keys.");
    } else {
      setMsg("Could not revoke the API key.");
    }
  }

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              API keys are available to admins and owners only.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
        <p className="text-sm text-muted-foreground">
          Programmatic access to this workspace. Send a key as{" "}
          <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* One-time secret reveal */}
      {created ? (
        <Card>
          <CardHeader>
            <CardTitle>Copy your new API key</CardTitle>
            <CardDescription>
              This is the only time the full key is shown. Store it securely — you
              cannot retrieve it again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Row>
              <Input readOnly value={created.secret} className="font-mono" />
              <Button type="button" variant="secondary" onClick={copySecret}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </Row>
            <Button type="button" variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Create */}
      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>
            Name it so you can recognise it later (admin only).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Row>
              <Input
                id="key-name"
                placeholder="CI deploy bot"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
              <Button type="submit" disabled={creating || name.trim().length === 0}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </Row>
          </form>
        </CardContent>
      </Card>

      {/* List */}
      <Card>
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
          <CardDescription>Keys grant the role they were created with.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search keys…"
            view={query.view}
            onViewChange={query.setView}
          />

          {(() => {
            const renderActions = (k: (typeof pagedKeys)[number]) =>
              k.revokedAt ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => revoke(k.id)}
                >
                  Revoke
                </Button>
              );

            const columns: DataTableColumn<ApiKey>[] = [
              { key: "name", header: "Name" },
              {
                key: "prefix",
                header: "Prefix",
                render: (k) => (
                  <span className="font-mono text-muted-foreground">{k.prefix}…</span>
                ),
              },
              {
                key: "role",
                header: "Role",
                render: (k) => (
                  <Badge variant="secondary" className="capitalize">
                    {k.role}
                  </Badge>
                ),
              },
              {
                key: "lastUsedAt",
                header: "Last used",
                render: (k) => (
                  <span className="text-muted-foreground">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (k) => (
                  <Badge variant={k.revokedAt ? "outline" : "success"}>
                    {k.revokedAt ? "revoked" : "active"}
                  </Badge>
                ),
              },
              { key: "actions", header: "", render: renderActions },
            ];

            return query.view === "grid" ? (
              <DataTableGrid
                rows={pagedKeys}
                rowKey={(k) => k.id}
                loading={loading}
                emptyMessage="No API keys yet."
                renderCard={(k) => (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{k.name}</p>
                      <Badge variant={k.revokedAt ? "outline" : "success"}>
                        {k.revokedAt ? "revoked" : "active"}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {k.prefix}…
                    </p>
                    {renderActions(k)}
                  </div>
                )}
              />
            ) : (
              <DataTable
                columns={columns}
                rows={pagedKeys}
                rowKey={(k) => k.id}
                loading={loading}
                emptyMessage="No API keys yet."
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
