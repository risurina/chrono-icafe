"use client";

import { useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";

export function CreateBranchStep({ item, onDone }: StepFormProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setSaving(true);
    const res = await api.rpc.branches.$post({ json: { name: name.trim(), code: code.trim() } });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not create the branch.");
      return;
    }
    toast.success("Branch created.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="branch-name">Branch name</Label>
        <Input id="branch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main Branch" />
      </Field>
      <Field>
        <Label htmlFor="branch-code">Branch code</Label>
        <Input id="branch-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="MAIN" />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Creating…" : "Create branch"}
      </Button>
    </form>
  );
}
