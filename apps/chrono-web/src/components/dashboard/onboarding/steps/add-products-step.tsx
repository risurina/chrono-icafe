"use client";

import { useState } from "react";
import { Button, Field, Input, Label, toast } from "agora/ui";
import { api } from "@/lib/rpc";
import type { StepFormProps } from "./types";

export function AddProductsStep({ item, onDone }: StepFormProps) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  if (item.done) return null;
  if (!item.actionable) {
    return <p className="text-sm text-muted-foreground">Ask an admin to complete this step.</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !price.trim()) return;
    setSaving(true);
    const res = await api.rpc.pos.products.$post({
      json: { name: name.trim(), price: price.trim() },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not add the product.");
      return;
    }
    toast.success("Product added.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field>
        <Label htmlFor="product-name">Product name</Label>
        <Input id="product-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Soda" />
      </Field>
      <Field>
        <Label htmlFor="product-price">Price</Label>
        <Input
          id="product-price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="25.00"
          inputMode="decimal"
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Adding…" : "Add product"}
      </Button>
    </form>
  );
}
