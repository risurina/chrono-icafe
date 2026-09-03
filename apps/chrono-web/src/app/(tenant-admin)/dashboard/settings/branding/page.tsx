"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Stack,
  Row,
  Dropzone,
} from "agora/ui";
import { tenantFetch } from "agora/client";
import { api } from "@/lib/rpc";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type BrandingForm = {
  displayName: string;
  tagline: string;
  supportEmail: string;
  logoUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  primaryColor: string;
  accentColor: string;
  theme: "system" | "light" | "dark";
  emailFromName: string;
  emailReplyTo: string;
  emailLogoUrl: string;
  customCss: string;
};

const EMPTY: BrandingForm = {
  displayName: "",
  tagline: "",
  supportEmail: "",
  logoUrl: "",
  logoDarkUrl: "",
  faviconUrl: "",
  primaryColor: "",
  accentColor: "",
  theme: "system",
  emailFromName: "",
  emailReplyTo: "",
  emailLogoUrl: "",
  customCss: "",
};

// Turn "" into null for a partial upsert; leave other values as-is.
function toPayload(f: BrandingForm) {
  const nn = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    displayName: nn(f.displayName),
    tagline: nn(f.tagline),
    supportEmail: nn(f.supportEmail),
    logoUrl: nn(f.logoUrl),
    logoDarkUrl: nn(f.logoDarkUrl),
    faviconUrl: nn(f.faviconUrl),
    primaryColor: nn(f.primaryColor),
    accentColor: nn(f.accentColor),
    theme: f.theme,
    emailFromName: nn(f.emailFromName),
    emailReplyTo: nn(f.emailReplyTo),
    emailLogoUrl: nn(f.emailLogoUrl),
    customCss: nn(f.customCss),
  };
}

export default function BrandingPage() {
  const [form, setForm] = useState<BrandingForm>(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [emailPreview, setEmailPreview] = useState<string | null>(null);

  const set = <K extends keyof BrandingForm>(k: K, v: BrandingForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function load() {
    const res = await api.rpc.branding.$get();
    if (!res.ok) return;
    const b = (await res.json()).branding as Partial<BrandingForm>;
    setForm({ ...EMPTY, ...cleanNulls(b) });
  }

  useEffect(() => {
    load();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await api.rpc.branding.$put({ json: toPayload(form) });
    setSaving(false);
    if (res.ok) {
      setMsg("Branding saved. Reload to see it applied across the app.");
      load();
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can edit branding.");
    } else {
      setMsg("Could not save (check colors are #rrggbb and URLs are https).");
    }
  }

  async function previewEmail() {
    setMsg(null);
    const res = await api.rpc.branding["email-preview"].$get();
    if (res.ok) setEmailPreview((await res.json()).preview.html);
    else if ((res.status as number) === 403)
      setMsg("Only admins can preview email branding.");
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Branding</h1>
        <p className="text-sm text-muted-foreground">
          White-label this business: name, logo, colors, and email branding (admin
          only).
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <form onSubmit={save} className="space-y-6">
          {/* Identity */}
          <Card>
            <CardHeader>
              <CardTitle>Brand identity</CardTitle>
              <CardDescription>Shown across the tenant surfaces.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Display name" htmlFor="displayName">
                <Input
                  id="displayName"
                  value={form.displayName}
                  onChange={(e) => set("displayName", e.target.value)}
                  placeholder="Acme Inc."
                />
              </Field>
              <Field label="Tagline" htmlFor="tagline">
                <Input
                  id="tagline"
                  value={form.tagline}
                  onChange={(e) => set("tagline", e.target.value)}
                  placeholder="The best way to do the thing."
                />
              </Field>
              <Field label="Support email" htmlFor="supportEmail">
                <Input
                  id="supportEmail"
                  type="email"
                  value={form.supportEmail}
                  onChange={(e) => set("supportEmail", e.target.value)}
                  placeholder="support@acme.com"
                />
              </Field>
            </CardContent>
          </Card>

          {/* Appearance */}
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Colors and default theme.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <ColorField
                  label="Primary color"
                  value={form.primaryColor}
                  onChange={(v) => set("primaryColor", v)}
                />
                <ColorField
                  label="Accent color"
                  value={form.accentColor}
                  onChange={(v) => set("accentColor", v)}
                />
              </div>
              <Field label="Default theme" htmlFor="theme">
                <Select
                  value={form.theme}
                  onValueChange={(v) => set("theme", v as BrandingForm["theme"])}
                >
                  <SelectTrigger id="theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>

          {/* Logos */}
          <Card>
            <CardHeader>
              <CardTitle>Logos &amp; favicon</CardTitle>
              <CardDescription>
                Upload an image (PNG, JPEG, GIF, WebP, ICO — max 2 MB) or paste an https
                URL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <AssetField
                label="Logo"
                value={form.logoUrl}
                onChange={(v) => set("logoUrl", v)}
                onError={setMsg}
              />
              <AssetField
                label="Logo (dark)"
                value={form.logoDarkUrl}
                onChange={(v) => set("logoDarkUrl", v)}
                onError={setMsg}
              />
              <AssetField
                label="Favicon"
                value={form.faviconUrl}
                onChange={(v) => set("faviconUrl", v)}
                onError={setMsg}
              />
            </CardContent>
          </Card>

          {/* Email */}
          <Card>
            <CardHeader>
              <CardTitle>Email branding</CardTitle>
              <CardDescription>
                Applied to transactional email sent to your customers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="From name" htmlFor="emailFromName">
                <Input
                  id="emailFromName"
                  value={form.emailFromName}
                  onChange={(e) => set("emailFromName", e.target.value)}
                  placeholder="Acme"
                />
              </Field>
              <Field label="Reply-to" htmlFor="emailReplyTo">
                <Input
                  id="emailReplyTo"
                  type="email"
                  value={form.emailReplyTo}
                  onChange={(e) => set("emailReplyTo", e.target.value)}
                  placeholder="hello@acme.com"
                />
              </Field>
              <AssetField
                label="Email logo"
                value={form.emailLogoUrl}
                onChange={(v) => set("emailLogoUrl", v)}
                onError={setMsg}
              />
              <Button type="button" variant="outline" onClick={previewEmail}>
                Preview email
              </Button>
            </CardContent>
          </Card>

          {/* Advanced */}
          <Card>
            <CardHeader>
              <CardTitle>Custom CSS</CardTitle>
              <CardDescription>
                Advanced. Sanitized server-side before it is applied; some constructs
                (imports, scripts, external urls) are stripped.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={form.customCss}
                onChange={(e) => set("customCss", e.target.value)}
                placeholder=".dashboard-header { letter-spacing: 0.02em; }"
                className="min-h-[140px] font-mono text-xs"
              />
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save branding"}
              </Button>
            </CardFooter>
          </Card>
        </form>

        {/* Live preview */}
        <Stack gap={4}>
          <Card className="sticky top-6">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>Colors update live.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                {form.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.logoUrl} alt="Logo preview" className="h-8 w-auto" />
                ) : (
                  <span
                    className="text-lg font-semibold"
                    style={colorStyle(form.primaryColor)}
                  >
                    {form.displayName || "Your brand"}
                  </span>
                )}
              </div>
              {form.tagline ? (
                <p className="text-sm text-muted-foreground">{form.tagline}</p>
              ) : null}
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: form.primaryColor || "#171717" }}
              >
                Primary button
              </button>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-sm font-medium"
                style={{
                  backgroundColor: form.accentColor || "#f5f5f5",
                  color: readableTextColor(form.accentColor || "#f5f5f5"),
                }}
              >
                Accent surface
              </button>
            </CardContent>
          </Card>

          {emailPreview ? (
            <Card>
              <CardHeader>
                <CardTitle>Email preview</CardTitle>
              </CardHeader>
              <CardContent>
                <iframe
                  title="Branded email preview"
                  className="h-80 w-full rounded-md border"
                  sandbox=""
                  srcDoc={emailPreview}
                />
              </CardContent>
            </Card>
          ) : null}
        </Stack>
      </div>
    </Stack>
  );
}

function cleanNulls(b: Partial<Record<keyof BrandingForm, unknown>>) {
  const out: Partial<BrandingForm> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "theme") {
      out.theme = (v as BrandingForm["theme"]) ?? "system";
    } else if (typeof v === "string") {
      out[k as keyof Omit<BrandingForm, "theme">] = v;
    }
  }
  return out;
}

function colorStyle(hex: string): React.CSSProperties {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? { color: hex } : {};
}

/** Picks black or white text so it stays readable against an arbitrary hex background. */
function readableTextColor(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "#111827";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap={2}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </Stack>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Stack gap={2}>
      <Label>{label}</Label>
      <Row>
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 rounded-md border border-input bg-transparent"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#171717"
        />
      </Row>
    </Stack>
  );
}

function AssetField({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onError: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await tenantFetch()(`${API_URL}/rpc/branding/asset`, {
        method: "POST",
        body: fd,
      });
      if (res.ok) {
        onChange((await res.json()).url as string);
      } else {
        const err = await res.json().catch(() => ({}));
        onError((err as { error?: string }).error ?? "Upload failed.");
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <Stack gap={2}>
      <Label>{label}</Label>
      <Row>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://…"
        />
        <div className="w-48">
          <Dropzone
            uploading={uploading}
            accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon"
            onFiles={(files) => {
              const f = files[0];
              if (f) upload(f);
            }}
          />
        </div>
      </Row>
    </Stack>
  );
}
