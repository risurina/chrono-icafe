"use client";

import { useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";
import { useFirstBranch } from "./types";

export function AddStationGroupStep({ item, onDone }: StepFormProps) {
  const branch = useFirstBranch();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [saving, setSaving] = useState(false);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }
  if (!branch) {
    return <p className="text-sm text-muted-foreground">Create a branch first.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branch || !name.trim() || !code.trim() || !hourlyRate.trim()) return;
    setSaving(true);
    const res = await api.rpc.stations.groups.$post({
      json: {
        branchId: branch.id,
        name: name.trim(),
        code: code.trim(),
        hourlyRate: Number(hourlyRate),
      },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not create the station group.");
      return;
    }
    toast.success("Station group created.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="group-name">Group name</Label>
        <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard" />
      </Field>
      <Field>
        <Label htmlFor="group-code">Group code</Label>
        <Input id="group-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="STD" />
      </Field>
      <Field>
        <Label htmlFor="group-rate">Hourly rate</Label>
        <Input
          id="group-rate"
          type="number"
          min="0"
          step="0.01"
          value={hourlyRate}
          onChange={(e) => setHourlyRate(e.target.value)}
          placeholder="30"
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Creating…" : "Create station group"}
      </Button>
    </form>
  );
}
