"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  Stack,
  Row,
  ListRow,
  ListRows,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  SystemHealth,
  ComponentHealth,
  ComponentHealthStatus,
  OverallHealthStatus,
  SystemHealthEvent,
} from "agora";

/**
 * Platform System Health — read-only, observational (gated `systemHealth:read`,
 * all platform roles). Live probe-on-read component status from
 * `GET /rpc-admin/system-health` plus recent system events from
 * `GET /rpc-admin/system-health/events`. Components with no real probe render an
 * explicit "Not applicable / Not configured" state — never a fabricated green.
 * Auto-refreshes on an interval (the Phase-2 short cache makes polling safe).
 */

const REFRESH_MS = 30_000;

const STATUS_LABEL: Record<ComponentHealthStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  not_applicable: "Not applicable",
  not_configured: "Not configured",
};

function statusVariant(
  status: ComponentHealthStatus,
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "operational":
      return "success";
    case "degraded":
      return "warning";
    case "down":
      return "destructive";
    default:
      return "secondary";
  }
}

const OVERALL_LABEL: Record<OverallHealthStatus, string> = {
  operational: "All systems operational",
  degraded: "Some systems degraded",
  down: "Systems down",
};

function overallVariant(
  status: OverallHealthStatus,
): "success" | "warning" | "destructive" {
  return status === "operational"
    ? "success"
    : status === "degraded"
      ? "warning"
      : "destructive";
}

export default function PlatformSystemHealthPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [events, setEvents] = useState<SystemHealthEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [healthRes, eventsRes] = await Promise.all([
      adminApi["rpc-admin"]["system-health"].$get(),
      adminApi["rpc-admin"]["system-health"].events.$get(),
    ]);
    setLoading(false);
    if ((healthRes.status as number) === 403) {
      setForbidden(true);
      return;
    }
    if (healthRes.ok) setHealth((await healthRes.json()) as SystemHealth);
    if (eventsRes.ok) {
      const body = await eventsRes.json();
      setEvents(body.events as SystemHealthEvent[]);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (forbidden) {
    return (
      <Stack>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              System health is available to platform staff only.
            </p>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      <Row className="items-start justify-between" gap={4}>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
          <p className="text-sm text-muted-foreground">
            Live infrastructure status — read-only. Components with no probe show
            an explicit state, never a fabricated one.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </Row>

      {health ? (
        <Card>
          <CardContent className="p-4">
            <Row className="items-center justify-between" gap={4} wrap>
              <Row className="items-center" gap={3}>
                <Badge variant={overallVariant(health.overall)}>
                  {OVERALL_LABEL[health.overall]}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Error rate:{" "}
                  {health.errorRate === null
                    ? "n/a"
                    : `${(health.errorRate * 100).toFixed(2)}%`}
                </span>
              </Row>
              <span className="text-xs text-muted-foreground tabular-nums">
                Checked {new Date(health.checkedAt).toLocaleTimeString()}
              </span>
            </Row>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
          <CardDescription>
            Per-component operational status and response time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {health ? (
            <ListRows>
              {health.components.map((component: ComponentHealth) => (
                <ListRow
                  key={component.key}
                  actions={
                    <Badge variant={statusVariant(component.status)}>
                      {STATUS_LABEL[component.status]}
                    </Badge>
                  }
                >
                  <Stack gap={1}>
                    <Row className="items-center" gap={2}>
                      <span className="font-medium">{component.label}</span>
                      {component.responseTimeMs !== null ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {component.responseTimeMs} ms
                        </span>
                      ) : null}
                    </Row>
                    {component.detail ? (
                      <span className="text-xs text-muted-foreground">
                        {component.detail}
                      </span>
                    ) : null}
                  </Stack>
                </ListRow>
              ))}
            </ListRows>
          ) : (
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading component status…" : "No health data."}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent system events</CardTitle>
          <CardDescription>
            Platform configuration and enforcement changes from the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events && events.length > 0 ? (
                  events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Row className="items-center" gap={2}>
                          <span className="font-medium">{event.action}</span>
                          {event.result !== "success" ? (
                            <Badge variant="destructive">{event.result}</Badge>
                          ) : null}
                        </Row>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {[event.actorLabel, event.targetLabel]
                            .filter(Boolean)
                            .join(" → ") || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {new Date(event.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                      No recent system events.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}
