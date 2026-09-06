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
  Row,
  Stack,
  Badge,
  toast,
  Can,
} from "agora/ui";
import type { LandingSnapshot, SectionsConfig } from "agora";
import { api } from "@/lib/rpc";
import { ThemePicker } from "@/components/dashboard/landing/theme-picker";
import { SectionsEditor } from "@/components/dashboard/landing/sections-editor";
import { TENANT_SECTION_CHOICES } from "@/components/landing/registry";

/**
 * Landing-page settings.
 *
 * Content, theme and section layout all write the tenant's DRAFT; Publish
 * copies the draft to what visitors see. That split is why editing a live page
 * is safe — nothing here changes the public page until Publish is pressed.
 *
 * The three editing concerns are separate components (theme picker, sections
 * editor, and the content form below) rather than one file; the prior-art
 * equivalent is a single 815-line component.
 */

type LandingPageForm = {
  heroTitle: string;
  heroSubtitle: string;
  aboutTitle: string;
  aboutBody: string;
  ctaLabel: string;
  ctaHref: string;
  seoDescription: string;
};

const EMPTY: LandingPageForm = {
  heroTitle: "",
  heroSubtitle: "",
  aboutTitle: "",
  aboutBody: "",
  ctaLabel: "",
  ctaHref: "",
  seoDescription: "",
};

/** Conventional OpenGraph/meta-description length — matches the Zod cap on
 * `landingConfigSchema.seo.description` (`packages/agora/src/core/contracts/landing.ts`). */
const SEO_DESCRIPTION_MAX_LENGTH = 300;

type Permissions = Record<string, string[]>;

const nn = (v: string) => (v.trim() === "" ? undefined : v.trim());

/** Turn the flat form into the foundation's nested config shape. */
function toConfig(f: LandingPageForm): LandingSnapshot["config"] {
  const cta =
    nn(f.ctaLabel) && nn(f.ctaHref)
      ? { label: f.ctaLabel.trim(), href: f.ctaHref.trim() }
      : undefined;
  return {
    hero: {
      title: nn(f.heroTitle),
      subtitle: nn(f.heroSubtitle),
      primaryCta: cta,
    },
    about: { title: nn(f.aboutTitle), body: nn(f.aboutBody) },
    seo: { description: nn(f.seoDescription) },
  };
}

function fromConfig(config: LandingSnapshot["config"]): LandingPageForm {
  return {
    heroTitle: config?.hero?.title ?? "",
    heroSubtitle: config?.hero?.subtitle ?? "",
    aboutTitle: config?.about?.title ?? "",
    aboutBody: config?.about?.body ?? "",
    ctaLabel: config?.hero?.primaryCta?.label ?? "",
    ctaHref: config?.hero?.primaryCta?.href ?? "",
    seoDescription: config?.seo?.description ?? "",
  };
}

export default function LandingPageSettingsPage() {
  const [form, setForm] = useState<LandingPageForm>(EMPTY);
  const [sections, setSections] = useState<SectionsConfig>({});
  const [themePreset, setThemePreset] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permissions | undefined>(undefined);
  const [isPublished, setIsPublished] = useState(false);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

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
        const data = await contentRes.json();
        setForm(fromConfig(data.draft?.config));
        setSections(data.draft?.sections ?? {});
        setThemePreset(data.draft?.themePreset ?? null);
        setIsPublished(data.isPublished);
        setPublishedAt(data.publishedAt);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    const res = await api.rpc["landing-page"].$patch({
      json: { config: toConfig(form), sections, themePreset },
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not save landing page content.");
      return;
    }
    toast.success("Landing page updated.");
  }

  async function onPublish() {
    setPublishing(true);
    const res = await api.rpc["landing-page"].publish.$post();
    setPublishing(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not publish the landing page.");
      return;
    }
    const data = await res.json();
    setIsPublished(true);
    setPublishedAt(data.publishedAt);
    toast.success("Landing page published.");
  }

  async function onUnpublish() {
    setPublishing(true);
    const res = await api.rpc["landing-page"].unpublish.$post();
    setPublishing(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not unpublish the landing page.");
      return;
    }
    setIsPublished(false);
    toast.success("Landing page unpublished.");
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <Can permissions={permissions} resource="landingPage" action="manage">
      <Stack gap={4}>
        <Card>
          <CardHeader>
            <Row className="items-center justify-between">
              <Stack gap={1}>
                <CardTitle>Publishing</CardTitle>
                <CardDescription>
                  Edits are saved as a draft. Your public page only changes when
                  you publish. Publishing also lists your business on
                  Chrono&apos;s public discovery page, where players can find
                  you — unpublishing removes it again.
                </CardDescription>
              </Stack>
              <Badge variant={isPublished ? "default" : "secondary"}>
                {isPublished ? "Live" : "Draft"}
              </Badge>
            </Row>
          </CardHeader>
          <CardFooter>
            <Row wrap className="items-center gap-3">
              <Button
                onClick={onPublish}
                disabled={publishing}
                data-testid="landing-publish"
              >
                {publishing ? "Working…" : isPublished ? "Publish changes" : "Publish"}
              </Button>
              {isPublished ? (
                <Button
                  variant="outline"
                  onClick={onUnpublish}
                  disabled={publishing}
                  data-testid="landing-unpublish"
                >
                  Unpublish
                </Button>
              ) : null}
              {publishedAt ? (
                <span className="text-sm text-muted-foreground">
                  Last published {new Date(publishedAt).toLocaleString()}
                </span>
              ) : null}
            </Row>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Pick a colour theme, then choose which sections appear and in what
              order.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <ThemePicker value={themePreset} onChange={setThemePreset} />
            <SectionsEditor
              choices={TENANT_SECTION_CHOICES}
              value={sections}
              onChange={setSections}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Public landing page</CardTitle>
            <CardDescription>
              Content shown at <code>/about</code> on your business&apos;s host — no
              sign-in required.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="heroTitle">Hero tagline</Label>
              <Input
                id="heroTitle"
                value={form.heroTitle}
                onChange={(e) => set("heroTitle", e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="heroSubtitle">Hero subtitle</Label>
              <Input
                id="heroSubtitle"
                value={form.heroSubtitle}
                onChange={(e) => set("heroSubtitle", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aboutTitle">About heading</Label>
              <Input
                id="aboutTitle"
                value={form.aboutTitle}
                onChange={(e) => set("aboutTitle", e.target.value)}
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
            <div className="col-span-2 space-y-2">
              <Label htmlFor="about">About</Label>
              <Textarea
                id="about"
                rows={4}
                value={form.aboutBody}
                onChange={(e) => set("aboutBody", e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="ctaHref">Call-to-action link</Label>
              <Input
                id="ctaHref"
                placeholder="/stations or https://…"
                value={form.ctaHref}
                onChange={(e) => set("ctaHref", e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="seoDescription">SEO description</Label>
              <Textarea
                id="seoDescription"
                rows={3}
                maxLength={SEO_DESCRIPTION_MAX_LENGTH}
                placeholder="A sentence or two describing your business for search results and shared links."
                value={form.seoDescription}
                onChange={(e) => set("seoDescription", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shown in search results and link previews (e.g. when shared on
                social media). Falls back to the hero subtitle if left blank.{" "}
                {form.seoDescription.length}/{SEO_DESCRIPTION_MAX_LENGTH}
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={onSave} disabled={saving} data-testid="landing-save">
              {saving ? "Saving…" : "Save"}
            </Button>
          </CardFooter>
        </Card>
      </Stack>
    </Can>
  );
}
