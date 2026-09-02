"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Timer } from "lucide-react";
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Field,
  Row,
  AuthLayout,
  PageShell,
  Main,
  SiteHeader,
  SiteFooter,
  ThemeToggle,
  toast,
} from "agora/ui";
import { slugSchema } from "agora";
import { authClient, useSession } from "@/lib/auth-client";

const currentYear = new Date().getFullYear();

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // Drop apostrophes rather than turning them into separators, so a
    // possessive name ("rony 03's business") slugs to `rony-03s-business`
    // and not `rony-03-s-business`.
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Create an additional business for an already-authenticated user. */
export default function NewBusinessPage() {
  const { data: session, isPending } = useSession();

  const [business, setBusiness] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [businessTouched, setBusinessTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    setWelcome(new URLSearchParams(window.location.search).get("welcome") === "1");
  }, []);

  // A user arriving here straight from a social sign-in has typed nothing yet;
  // seed the business name from their profile so the common case is one click.
  useEffect(() => {
    const name = session?.user?.name;
    if (!businessTouched && name) setBusiness(`${name}'s business`);
  }, [session?.user?.name, businessTouched]);

  const effectiveSlug = slugTouched ? slug : slugify(business);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    const parsed = slugSchema.safeParse(effectiveSlug);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid business URL");
      return;
    }
    setLoading(true);

    const org = await authClient.organization.create({
      name: business,
      slug: parsed.data,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (org.error) {
      toast.error(org.error.message ?? "Could not create business");
      setLoading(false);
      return;
    }

    const proto = location.protocol;
    location.href = `${proto}//${parsed.data}.${APP_DOMAIN}/dashboard`;
  }

  const header = (
    <SiteHeader
      maxWidth="full"
      brand={
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Timer className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span>Chrono</span>
        </Link>
      }
      actions={<ThemeToggle />}
    />
  );

  const footer = (
    <SiteFooter
      maxWidth="full"
      brand={<span>© {currentYear} Chrono. All rights reserved.</span>}
    />
  );

  if (isPending) {
    return (
      <PageShell>
        {header}
        <Main>
          <AuthLayout className="min-h-0 py-16">
            <Card>
              <CardHeader>
                <CardTitle>&nbsp;</CardTitle>
              </CardHeader>
            </Card>
          </AuthLayout>
        </Main>
        {footer}
      </PageShell>
    );
  }

  if (!session) {
    if (typeof window !== "undefined") {
      location.href = `${location.protocol}//${APP_DOMAIN}/sign-up`;
    }
    return null;
  }

  return (
    <PageShell>
      {header}
      <Main>
        <AuthLayout className="min-h-0 py-16">
          <Card>
            <CardHeader>
              <CardTitle>
                {welcome ? "Welcome — create your business" : "Create a new business"}
              </CardTitle>
              <CardDescription>
                {welcome
                  ? "Your account is ready. Name your business to finish setting up."
                  : "You'll be the owner of this new tenant."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="space-y-4">
                <Field>
                  <Label htmlFor="business">Business name</Label>
                  <Input
                    id="business"
                    required
                    value={business}
                    onChange={(e) => {
                      setBusinessTouched(true);
                      setBusiness(e.target.value);
                    }}
                  />
                </Field>
                <Field>
                  <Label htmlFor="slug">Business URL</Label>
                  <Row items="center" gap={1}>
                    <Input
                      id="slug"
                      value={effectiveSlug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setSlug(slugify(e.target.value));
                      }}
                    />
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                      .{APP_DOMAIN}
                    </span>
                  </Row>
                </Field>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Creating…" : "Create business"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </AuthLayout>
      </Main>
      {footer}
    </PageShell>
  );
}
