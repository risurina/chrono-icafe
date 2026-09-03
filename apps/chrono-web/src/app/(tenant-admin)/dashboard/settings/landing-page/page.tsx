"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Stack,
  toast,
  Can,
} from "agora/ui";
import { api } from "@/lib/rpc";

type LandingPageForm = {
  heroTagline: string;
  aboutBody: string;
  amenitiesBody: string;
  contactOverride: string;
  ctaLabel: string;
  ctaHref: string;
};

const EMPTY: LandingPageForm = {
  heroTagline: "",
  aboutBody: "",
  amenitiesBody: "",
  contactOverride: "",
  ctaLabel: "",
  ctaHref: "",
};

type Permissions = Record<string, string[]>;

// Turn "" into null for a partial upsert; leave other values as-is — matches
// the branding settings page's own toPayload() convention.
function toPayload(f: LandingPageForm) {
  const nn = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    heroTagline: nn(f.heroTagline),
    aboutBody: nn(f.aboutBody),
    amenitiesBody: nn(f.amenitiesBody),
    contactOverride: nn(f.contactOverride),
    ctaLabel: nn(f.ctaLabel),
    ctaHref: nn(f.ctaHref),
  };
}

export default function LandingPageSettingsPage() {
  const [form, setForm] = useState<LandingPageForm>(EMPTY);
  const [permissions, setPermissions] = useState<Permissions | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof LandingPageForm>(k: K, v: LandingPageForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [meRes, contentRes] = await Promise.all([
        api.rpc.me.$get(),
        api.rpc["landing-page"].$get(),
      ]);
      if (!mounted) return;
      if (meRes.ok) {
        const me = await meRes.json();
        setPermissions(me.permissions);
      }
      if (contentRes.ok) {
        const { content } = await contentRes.json();
        if (content) {
          setForm({
            heroTagline: content.heroTagline ?? "",
            aboutBody: content.aboutBody ?? "",
            amenitiesBody: content.amenitiesBody ?? "",
            contactOverride: content.contactOverride ?? "",
            ctaLabel: content.ctaLabel ?? "",
            ctaHref: content.ctaHref ?? "",
          });
        }
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    const res = await api.rpc["landing-page"].$patch({ json: toPayload(form) });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not save landing page content.");
      return;
    }
    toast.success("Landing page updated.");
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <Can permissions={permissions} resource="landingPage" action="manage">
      <Stack>
        <Card>
          <CardHeader>
            <CardTitle>Public landing page</CardTitle>
            <CardDescription>
              Content shown at <code>/about</code> on your business&apos;s host — no
              sign-in required.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="heroTagline">Hero tagline</Label>
              <Input
                id="heroTagline"
                value={form.heroTagline}
                onChange={(e) => set("heroTagline", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aboutBody">About</Label>
              <Textarea
                id="aboutBody"
                rows={4}
                value={form.aboutBody}
                onChange={(e) => set("aboutBody", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amenitiesBody">Amenities</Label>
              <Textarea
                id="amenitiesBody"
                rows={4}
                value={form.amenitiesBody}
                onChange={(e) => set("amenitiesBody", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactOverride">Contact override</Label>
              <Input
                id="contactOverride"
                placeholder="Leave blank to show your branches' own contact info"
                value={form.contactOverride}
                onChange={(e) => set("contactOverride", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ctaLabel">Call-to-action label</Label>
              <Input
                id="ctaLabel"
                value={form.ctaLabel}
                onChange={(e) => set("ctaLabel", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ctaHref">Call-to-action link</Label>
              <Input
                id="ctaHref"
                placeholder="/stations or https://…"
                value={form.ctaHref}
                onChange={(e) => set("ctaHref", e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </CardFooter>
        </Card>
      </Stack>
    </Can>
  );
}
