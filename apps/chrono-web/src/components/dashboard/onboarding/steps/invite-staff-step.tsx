"use client";

import { useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";

export function InviteStaffStep({ item, onDone }: StepFormProps) {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSaving(true);
    const res = await api.rpc.invites.$post({ json: { email: email.trim() } });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not send the invite.");
      return;
    }
    toast.success("Invite sent.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="invite-email">Email address</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Sending…" : "Send invite"}
      </Button>
    </form>
  );
}
