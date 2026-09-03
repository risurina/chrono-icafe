"use client";

import { useEffect, useState } from "react";
import {
  Switch,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  ListRow,
  Stack,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { FeatureFlagState } from "agora";

/**
 * The switch reflects the fully-RESOLVED value (what is actually on for this
 * tenant after the platform rules apply), while the PUT still writes the owner's
 * own override. When a platform kill switch or plan gate overrides the owner's
 * intent, we surface the reason instead of silently snapping the toggle back.
 */
function reasonNote(f: FeatureFlagState): string | null {
  if (f.reason === "killed") return "Disabled platform-wide";
  if (f.reason === "plan_excluded") return "Not included in your plan";
  return null;
}

export default function FeaturesPage() {
  const [features, setFeatures] = useState<FeatureFlagState[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const res = await api.rpc.features.$get();
    if (res.ok) setFeatures((await res.json()).features as FeatureFlagState[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(key: string, enabled: boolean) {
    setMsg(null);
    setPending(key);
    // No optimistic flip: the resolved value can differ from the owner's intent
    // (kill switch / plan gate), so we take the server's resolved response.
    const res = await api.rpc.features.$put({ json: { key, enabled } });
    setPending(null);
    if (res.ok) {
      const next = (await res.json()).features as FeatureFlagState[];
      setFeatures(next);
      const changed = next.find((x) => x.key === key);
      if (changed && changed.reason !== "override") {
        setMsg(
          changed.reason === "killed"
            ? "Saved — but this feature is disabled platform-wide, so it stays off."
            : changed.reason === "plan_excluded"
              ? "Saved — but this feature isn't included in your plan, so it stays off."
              : "Feature updated.",
        );
      } else {
        setMsg("Feature updated.");
      }
    } else {
      load();
      setMsg(
        (res.status as number) === 403
          ? "Only admins can change feature flags."
          : "Could not update feature.",
      );
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Features</h1>
        <p className="text-sm text-muted-foreground">
          Toggle functionality for this business (admin only). Some features are
          also governed by platform-wide rules (availability, rollout, or a kill
          switch), so the value shown is what is actually active for you.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
          <CardDescription>
            Each flag shows its effective value. A platform kill switch or plan
            gate can keep a feature off even if you turn it on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {features.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No feature flags are defined.
            </p>
          ) : (
            features.map((f) => {
              const note = reasonNote(f);
              return (
                <ListRow
                  key={f.key}
                  actions={
                    <Switch
                      checked={f.enabled}
                      disabled={pending === f.key}
                      aria-label={`Toggle ${f.label}`}
                      onCheckedChange={(next) => toggle(f.key, next)}
                    />
                  }
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{f.label}</p>
                      {note ? <Badge variant="outline">{note}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{f.description}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {f.key}
                    </p>
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
