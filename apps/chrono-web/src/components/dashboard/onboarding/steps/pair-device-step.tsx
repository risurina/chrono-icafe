"use client";

import { useState } from "react";
import { Badge, Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";
import { useFirstBranch } from "./types";

export function PairDeviceStep({ item, onDone }: StepFormProps) {
  const branch = useFirstBranch();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }
  if (!branch) {
    return <p className="text-sm text-muted-foreground">Create a branch first.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branch || !name.trim()) return;
    setSaving(true);
    const res = await api.rpc.devices["provisioning-tokens"].$post({
      json: { branchId: branch.id, name: name.trim() },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not create a pairing code.");
      return;
    }
    const body = await res.json();
    setPairingCode(body.provisioningToken.pairingCode);
    toast.success("Pairing code created.");
    onDone();
  }

  if (pairingCode) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Enter this code on the kiosk PC when it starts up:
        </p>
        <Badge variant="secondary" className="text-lg font-mono tracking-widest">
          {pairingCode}
        </Badge>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="device-name">Device name</Label>
        <Input id="device-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Front counter kiosk" />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Generating…" : "Generate pairing code"}
      </Button>
    </form>
  );
}
