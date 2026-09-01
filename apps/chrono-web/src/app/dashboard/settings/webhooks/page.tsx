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
  CardFooter,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Field,
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
import { cn } from "agora/ui/cn";
import {
  WEBHOOK_EVENTS,
  type WebhookEvent,
  type WebhookEndpoint,
  type WebhookDelivery,
} from "agora";
import { api } from "@/lib/rpc";

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<WebhookEvent[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const query = useListQuery();
  // Client-side pagination: webhook endpoints are a low-cardinality, per-tenant
  // resource — a backend list contract would be pure overhead, per
  // .ai/rules/data-listing.md.
  const { items: pagedEndpoints, meta } = useClientListPage(
    endpoints,
    query,
    (ep) => [ep.url],
  );

  const load = useCallback(async () => {
    const res = await api.rpc.webhooks.$get();
    if ((res.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setEndpoints((await res.json()).endpoints as WebhookEndpoint[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleEvent(ev: WebhookEvent) {
    setSelected((s) => (s.includes(ev) ? s.filter((e) => e !== ev) : [...s, ev]));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setSecret(null);
    if (selected.length === 0) {
      setMsg("Select at least one event to subscribe to.");
      return;
    }
    const res = await api.rpc.webhooks.$post({ json: { url, events: selected } });
    if (res.ok) {
      const body = await res.json();
      setSecret(body.secret as string);
      setUrl("");
      setSelected([]);
      setMsg("Endpoint created. Copy the signing secret now — it is shown once.");
      load();
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can manage webhooks.");
    } else {
      const err = await res.json().catch(() => ({}));
      setMsg((err as { error?: string }).error ?? "Could not create endpoint.");
    }
  }

  async function remove(id: string) {
    setMsg(null);
    const res = await api.rpc.webhooks[":id"].$delete({ param: { id } });
    if (res.ok) {
      if (openId === id) setOpenId(null);
      load();
      setMsg("Endpoint deleted.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can delete webhooks.");
    } else {
      setMsg("Could not delete endpoint.");
    }
  }

  async function viewDeliveries(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setDeliveries([]);
    const res = await api.rpc.webhooks[":id"].deliveries.$get({
      param: { id },
      query: { page: "1", pageSize: "20" },
    });
    if (res.ok) setDeliveries((await res.json()).items as WebhookDelivery[]);
  }

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Webhooks are available to admins and owners only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="text-sm text-muted-foreground">
          Receive signed, retried HTTP callbacks when events happen in this workspace
          (admin only).
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {secret ? (
        <Card>
          <CardHeader>
            <CardTitle>Signing secret</CardTitle>
            <CardDescription>
              Store this now — it is shown once and never again. Use it to verify the{" "}
              <span className="font-mono">X-Agora-Signature</span> header.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-all rounded-md border bg-muted p-3 font-mono text-sm">
              {secret}
            </p>
          </CardContent>
          <CardFooter>
            <Button variant="outline" onClick={() => setSecret(null)}>
              I've saved it
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {/* Create */}
      <Card>
        <CardHeader>
          <CardTitle>Add endpoint</CardTitle>
          <CardDescription>
            An https URL on a public host. Subscribe to one or more events.
          </CardDescription>
        </CardHeader>
        <form onSubmit={create}>
          <CardContent className="space-y-4">
            <Field>
              <Label htmlFor="url">Endpoint URL</Label>
              <Input
                id="url"
                type="url"
                placeholder="https://api.yourapp.com/webhooks/agora"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label>Events</Label>
              <Row wrap>
                {WEBHOOK_EVENTS.map((ev) => {
                  const on = selected.includes(ev);
                  return (
                    <Button
                      key={ev}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      className={cn("font-mono text-xs", on && "ring-2 ring-ring")}
                      onClick={() => toggleEvent(ev)}
                    >
                      {ev}
                    </Button>
                  );
                })}
              </Row>
            </Field>
          </CardContent>
          <CardFooter>
            <Button type="submit">Add endpoint</Button>
          </CardFooter>
        </form>
      </Card>

      {/* List */}
      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>Registered outbound endpoints.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search endpoints…"
            view={query.view}
            onViewChange={query.setView}
          />

          {(() => {
            const renderActions = (ep: WebhookEndpoint) => (
              <Row shrink items="center">
                {ep.enabled ? (
                  <Badge variant="success">enabled</Badge>
                ) : (
                  <Badge variant="warning">disabled</Badge>
                )}
                {ep.consecutiveFailures > 0 ? (
                  <Badge variant="warning">{ep.consecutiveFailures} fails</Badge>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => viewDeliveries(ep.id)}>
                  {openId === ep.id ? "Hide" : "Deliveries"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => remove(ep.id)}
                >
                  Delete
                </Button>
              </Row>
            );

            const columns: DataTableColumn<WebhookEndpoint>[] = [
              {
                key: "url",
                header: "Endpoint",
                render: (ep) => (
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{ep.url}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ep.events.join(", ")}
                    </p>
                  </div>
                ),
              },
              { key: "actions", header: "", render: renderActions },
            ];

            return query.view === "grid" ? (
              <DataTableGrid
                rows={pagedEndpoints}
                rowKey={(ep) => ep.id}
                emptyMessage="No endpoints yet."
                renderCard={(ep) => (
                  <div className="space-y-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{ep.url}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {ep.events.join(", ")}
                      </p>
                    </div>
                    {renderActions(ep)}
                  </div>
                )}
              />
            ) : (
              <DataTable
                columns={columns}
                rows={pagedEndpoints}
                rowKey={(ep) => ep.id}
                emptyMessage="No endpoints yet."
              />
            );
          })()}

          <DataTablePagination
            meta={meta}
            onPageChange={query.setPage}
            onPageSizeChange={query.setPageSize}
          />

          {openId ? (
            (() => {
              const ep = pagedEndpoints.find((e) => e.id === openId);
              if (!ep) return null;
              return (
                <div className="rounded-md border p-3">
                  <p className="mb-2 truncate font-mono text-xs text-muted-foreground">
                    Deliveries for {ep.url}
                  </p>
                  <div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Event</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Attempts</TableHead>
                          <TableHead>Code</TableHead>
                          <TableHead>When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deliveries.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="py-6 text-center text-sm text-muted-foreground"
                            >
                              No deliveries yet.
                            </TableCell>
                          </TableRow>
                        ) : (
                          deliveries.map((d) => (
                            <TableRow key={d.id}>
                              <TableCell className="font-mono text-xs">
                                {d.event}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    d.status === "success"
                                      ? "success"
                                      : d.status === "failed"
                                        ? "warning"
                                        : "secondary"
                                  }
                                >
                                  {d.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {d.attempts}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {d.responseCode ?? d.lastError ?? "—"}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-muted-foreground">
                                {new Date(d.createdAt).toLocaleString()}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              );
            })()
          ) : null}
        </CardContent>
      </Card>
    </Stack>
  );
}
