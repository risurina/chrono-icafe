"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";
import { useFirstBranch } from "./types";

export function AddStationStep({ item, onDone }: StepFormProps) {
  const branch = useFirstBranch();
  const [stationGroupId, setStationGroupId] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [stationNumber, setStationNumber] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!branch) return;
    api.rpc.stations.groups.$get({ query: { page: "1", pageSize: "1", branchId: branch.id } }).then(async (res) => {
      if (!res.ok) return;
      const body = await res.json();
      setStationGroupId(body.items[0]?.id);
    });
  }, [branch]);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }
  if (!branch) {
    return <p className="text-sm text-muted-foreground">Create a branch first.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branch || !name.trim() || !stationNumber.trim()) return;
    setSaving(true);
    const res = await api.rpc.stations.$post({
      json: {
        branchId: branch.id,
        stationGroupId,
        name: name.trim(),
        stationNumber: stationNumber.trim(),
      },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not create the station.");
      return;
    }
    toast.success("Station created.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="station-name">Station name</Label>
        <Input id="station-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="PC 1" />
      </Field>
      <Field>
        <Label htmlFor="station-number">Station number</Label>
        <Input
          id="station-number"
          value={stationNumber}
          onChange={(e) => setStationNumber(e.target.value)}
          placeholder="1"
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Creating…" : "Create station"}
      </Button>
    </form>
  );
}
