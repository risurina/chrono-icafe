"use client";

import { useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";
import { useFirstBranch } from "./types";

export function OpenShiftStep({ item, onDone }: StepFormProps) {
  const branch = useFirstBranch();
  const [openingCashAmount, setOpeningCashAmount] = useState("");
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
    if (!branch || !openingCashAmount.trim()) return;
    setSaving(true);
    const res = await api.rpc.shifts.open.$post({
      json: { branchId: branch.id, openingCashAmount: openingCashAmount.trim() },
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not open the shift.");
      return;
    }
    toast.success("Shift opened.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="opening-cash">Opening cash amount</Label>
        <Input
          id="opening-cash"
          value={openingCashAmount}
          onChange={(e) => setOpeningCashAmount(e.target.value)}
          placeholder="2000.00"
          inputMode="decimal"
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Opening…" : "Open shift"}
      </Button>
    </form>
  );
}
