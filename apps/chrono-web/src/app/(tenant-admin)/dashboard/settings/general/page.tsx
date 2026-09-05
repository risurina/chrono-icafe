"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Stack,
} from "agora/ui";
import { api } from "@/lib/rpc";

type Organization = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
};

export default function GeneralSettingsPage() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    const res = await api.rpc.organization.$get();
    if (res.ok) {
      const o = (await res.json()).organization as Organization;
      setOrg(o);
      setName(o.name);
      setForbidden(false);
    } else if ((res.status as number) === 403) {
      setForbidden(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await api.rpc.organization.$patch({ json: { name } });
    setSaving(false);
    if (res.ok) {
      setMsg("Business name updated.");
      load();
    } else if ((res.status as number) === 403) {
      setMsg("Only the owner can rename this business.");
    } else {
      setMsg("Could not save (name must be 1–120 characters).");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">General</h1>
        <p className="text-sm text-muted-foreground">
          Business name and basic details.
        </p>
      </div>

      {forbidden ? (
        <p className="text-sm text-muted-foreground">
          Only the owner can rename this business.
        </p>
      ) : (
        <>
          {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

          <form onSubmit={save}>
            <Card>
              <CardHeader>
                <CardTitle>Business identity</CardTitle>
                <CardDescription>
                  The name and basic details for this business.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Stack gap={2}>
                  <Label htmlFor="name">Business name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme Inc."
                  />
                </Stack>
                <Stack gap={2}>
                  <Label htmlFor="slug">Slug</Label>
                  <Input id="slug" value={org?.slug ?? ""} disabled readOnly />
                </Stack>
                <Stack gap={2}>
                  <Label htmlFor="createdAt">Created</Label>
                  <Input
                    id="createdAt"
                    value={org ? new Date(org.createdAt).toLocaleDateString() : ""}
                    disabled
                    readOnly
                  />
                </Stack>
              </CardContent>
              <CardFooter>
                <Button type="submit" disabled={saving || !org}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </CardFooter>
            </Card>
          </form>
        </>
      )}
    </Stack>
  );
}
