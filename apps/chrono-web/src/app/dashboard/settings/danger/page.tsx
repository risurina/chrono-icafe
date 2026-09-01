"use client";

import { useEffect, useState } from "react";
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
} from "agora/ui";
import { api } from "@/lib/rpc";

type Lifecycle = {
  tenantId: string;
  slug: string;
  status: "active" | "suspended" | "deleting";
  suspendedAt: string | null;
};

export default function DangerSettingsPage() {
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function loadAll() {
    const lc = await api.rpc.tenant.lifecycle.$get();
    if (lc.ok) setLifecycle((await lc.json()).lifecycle as Lifecycle);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function suspendWorkspace() {
    setMsg(null);
    const res = await api.rpc.tenant.suspend.$post();
    if (res.ok) {
      loadAll();
      setMsg("Workspace suspended. Members and customers are now blocked.");
    } else if ((res.status as number) === 403) {
      setMsg("Only the owner can suspend the workspace.");
    } else {
      setMsg("Could not suspend the workspace.");
    }
  }

  async function resumeWorkspace() {
    setMsg(null);
    const res = await api.rpc.tenant.resume.$post();
    if (res.ok) {
      loadAll();
      setMsg("Workspace resumed. Access restored.");
    } else if ((res.status as number) === 403) {
      setMsg("Only the owner can resume the workspace.");
    } else {
      setMsg("Could not resume the workspace.");
    }
  }

  async function exportWorkspace() {
    setMsg(null);
    const res = await api.rpc.tenant.export.$get();
    if (!res.ok) {
      setMsg(
        (res.status as number) === 403
          ? "Only the owner can export the workspace."
          : "Could not export the workspace.",
      );
      return;
    }
    const bundle = await res.json();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lifecycle?.slug ?? "workspace"}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Export downloaded.");
  }

  async function deleteWorkspace() {
    setMsg(null);
    const res = await api.rpc.tenant.delete.$post({ json: { confirmSlug } });
    if (res.ok) {
      window.location.href = "/login";
    } else if ((res.status as number) === 403) {
      setMsg("Only the owner can delete the workspace.");
    } else if ((res.status as number) === 400) {
      setMsg("The confirmation text does not match the workspace slug.");
    } else {
      setMsg("Could not delete the workspace.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Danger zone</h1>
        <p className="text-sm text-muted-foreground">
          Suspend, export, or permanently delete this workspace. Owner only.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* Danger zone (owner only — server enforces the owner role) */}
      {lifecycle ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Danger zone
              <Badge
                variant={lifecycle.status === "active" ? "success" : "warning"}
                className="capitalize"
              >
                {lifecycle.status}
              </Badge>
            </CardTitle>
            <CardDescription>
              Suspend blocks all access while retaining data. Resume restores it. Owner
              only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Row wrap>
              {lifecycle.status === "active" ? (
                <Button variant="destructive" onClick={suspendWorkspace}>
                  Suspend workspace
                </Button>
              ) : (
                <Button variant="outline" onClick={resumeWorkspace}>
                  Resume workspace
                </Button>
              )}
              <Button variant="outline" onClick={exportWorkspace}>
                Export data
              </Button>
            </Row>

            <div className="space-y-2 rounded-md border border-destructive/40 p-3">
              <Label htmlFor="confirmSlug">Delete this workspace permanently</Label>
              <p className="text-xs text-muted-foreground">
                This cannot be undone. Type the workspace slug{" "}
                <span className="font-mono font-semibold">{lifecycle.slug}</span> to
                confirm.
              </p>
              <Row>
                <Input
                  id="confirmSlug"
                  placeholder={lifecycle.slug}
                  value={confirmSlug}
                  onChange={(e) => setConfirmSlug(e.target.value)}
                />
                <Button
                  variant="destructive"
                  disabled={confirmSlug !== lifecycle.slug}
                  onClick={deleteWorkspace}
                >
                  Delete
                </Button>
              </Row>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </Stack>
  );
}
