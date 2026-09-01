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
  Label,
  Input,
  Textarea,
  Switch,
  Button,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Stack,
  Row,
  toast,
  Can,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { planIdSchema } from "agora";
import type { PlatformFeatureDetail, PlanIdDTO } from "agora";
import { usePlatformPermissions } from "../../layout";

const PLAN_IDS = planIdSchema.options;

export default function FeatureFlagDetailPage() {
  const permissions = usePlatformPermissions();
  const params = useParams<{ key: string }>();
  const key = params.key;
  const canManage = (permissions.featureFlag ?? []).includes("manage");

  const [detail, setDetail] = useState<PlatformFeatureDetail | null>(null);
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [globalDefault, setGlobalDefault] = useState(false);
  const [rollout, setRollout] = useState<string>("");
  const [allPlans, setAllPlans] = useState(true);
  const [plans, setPlans] = useState<PlanIdDTO[]>([]);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);

  const hydrate = useCallback((d: PlatformFeatureDetail) => {
    setDetail(d);
    setStatus(d.status);
    setGlobalDefault(d.globalDefault);
    setRollout(d.rolloutPercentage === null ? "" : String(d.rolloutPercentage));
    setAllPlans(d.planAvailability === null);
    setPlans(d.planAvailability ?? []);
    setLabel(d.label);
    setDescription(d.description);
    setCategory(d.category);
  }, []);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["feature-flags"][":key"].$get({
      param: { key },
    });
    if (!res.ok) {
      toast.error("Could not load this feature.");
      return;
    }
    hydrate((await res.json()) as PlatformFeatureDetail);
  }, [key, hydrate]);

  useEffect(() => {
    load();
  }, [load]);

  if (!detail) {
    return (
      <Stack gap={6}>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Stack>
    );
  }

  async function persist(nextStatus: "active" | "disabled") {
    setSaving(true);
    const rolloutNum = rollout.trim() === "" ? null : Number(rollout);
    const res = await adminApi["rpc-admin"]["feature-flags"][":key"].$patch({
      param: { key },
      json: {
        status: nextStatus,
        globalDefault,
        rolloutPercentage: rolloutNum,
        planAvailability: allPlans ? null : plans,
        label,
        description,
        category,
      },
    });
    setSaving(false);
    if (res.ok) {
      // Re-fetch the detail (the PATCH returns config only, no override table).
      await load();
      toast.success("Feature configuration saved.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not save the feature configuration.");
  }

  function togglePlan(p: PlanIdDTO, on: boolean) {
    setPlans((prev) => (on ? [...new Set([...prev, p])] : prev.filter((x) => x !== p)));
  }

  return (
    <Stack gap={6}>
      <div>
        <Link
          href="/admin/feature-flags"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Feature flags
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.label}</h1>
          {detail.status === "disabled" ? (
            <Badge variant="destructive">Disabled</Badge>
          ) : (
            <Badge variant="secondary">Active</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{detail.description}</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">{detail.key}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Global configuration</CardTitle>
          <CardDescription>
            Resolution order: kill switch → per-tenant override → plan availability
            → rollout → global default. These rules apply platform-wide; a tenant&apos;s
            own override still wins over rollout and default, but never over the kill
            switch or plan gate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Row items="center" justify="between">
            <div>
              <p className="text-sm font-medium">Kill switch</p>
              <p className="text-xs text-muted-foreground">
                When disabled, the feature is off for every tenant regardless of any
                override.
              </p>
            </div>
            <Switch
              checked={status === "active"}
              disabled={!canManage || saving}
              aria-label="Feature active"
              onCheckedChange={(next) => {
                if (!next) {
                  setConfirmKill(true);
                } else {
                  setStatus("active");
                }
              }}
            />
          </Row>

          <Row items="center" justify="between">
            <div>
              <p className="text-sm font-medium">Global default</p>
              <p className="text-xs text-muted-foreground">
                Effective value when no override, plan, or rollout rule decides it.
              </p>
            </div>
            <Switch
              checked={globalDefault}
              disabled={!canManage || saving}
              aria-label="Global default"
              onCheckedChange={setGlobalDefault}
            />
          </Row>

          <div className="space-y-2">
            <Label htmlFor="rollout">Rollout percentage</Label>
            <Input
              id="rollout"
              type="number"
              min={0}
              max={100}
              placeholder="No rollout gate"
              value={rollout}
              disabled={!canManage || saving}
              onChange={(e) => setRollout(e.target.value)}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">
              0–100. Leave blank for no rollout gate. Bucketing is deterministic per
              tenant, so membership is stable at a fixed percentage.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Plan availability</Label>
            <div className="flex items-center gap-2">
              <Switch
                id="all-plans"
                checked={allPlans}
                disabled={!canManage || saving}
                aria-label="Available on all plans"
                onCheckedChange={setAllPlans}
              />
              <Label htmlFor="all-plans" className="font-normal">
                Available on all plans
              </Label>
            </div>
            {!allPlans ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {PLAN_IDS.map((p) => {
                  const selected = plans.includes(p);
                  return (
                    <Button
                      key={p}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      disabled={!canManage || saving}
                      aria-pressed={selected}
                      onClick={() => togglePlan(p, !selected)}
                    >
                      {p}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={label}
              disabled={!canManage || saving}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              rows={2}
              value={description}
              disabled={!canManage || saving}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Input
              id="category"
              value={category}
              disabled={!canManage || saving}
              onChange={(e) => setCategory(e.target.value)}
              className="max-w-xs"
            />
          </div>
        </CardContent>
        <CardFooter>
          <Can permissions={permissions} resource="featureFlag" action="manage">
            <Button onClick={() => persist(status)} disabled={saving}>
              {saving ? "Saving…" : "Save configuration"}
            </Button>
          </Can>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where enabled</CardTitle>
          <CardDescription>
            Tenants with an explicit per-tenant override for this feature, and the
            net resolved value once the global rules apply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Override</TableHead>
                  <TableHead>Resolved</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.tenantOverrides.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-sm text-muted-foreground"
                    >
                      No tenant has an explicit override for this feature.
                    </TableCell>
                  </TableRow>
                ) : (
                  detail.tenantOverrides.map((t) => (
                    <TableRow key={t.tenantId}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{t.tenantName}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {t.tenantSlug}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{t.plan}</TableCell>
                      <TableCell>
                        <Badge variant={t.enabled ? "secondary" : "outline"}>
                          {t.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.resolvedOn ? "default" : "outline"}>
                          {t.resolvedOn ? "On" : "Off"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/admin/organizations/${t.tenantId}`}>
                          <Button variant="outline" size="sm">
                            Open org
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmKill} onOpenChange={setConfirmKill}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable this feature platform-wide?</DialogTitle>
            <DialogDescription>
              The kill switch turns &quot;{detail.label}&quot; off for every tenant,
              overriding any per-tenant enable. It is reversible — you can re-enable
              it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmKill(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={async () => {
                setConfirmKill(false);
                setStatus("disabled");
                await persist("disabled");
              }}
            >
              Disable feature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
