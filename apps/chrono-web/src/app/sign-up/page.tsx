"use client";

import { useState } from "react";
import Link from "next/link";
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
  toast,
} from "agora/ui";
import { slugSchema } from "agora";
import { authClient } from "@/lib/auth-client";
import { SocialSignIn, useAuthProviders } from "@/components/social-sign-in";

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

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [business, setBusiness] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const providers = useAuthProviders();

  const effectiveSlug = slugTouched ? slug : slugify(business);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    const parsed = slugSchema.safeParse(effectiveSlug);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid business URL");
      return;
    }
    setLoading(true);

    const signUp = await authClient.signUp.email({ email, password, name });
    if (signUp.error) {
      toast.error(signUp.error.message ?? "Sign up failed");
      setLoading(false);
      return;
    }

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

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Create your business</CardTitle>
          <CardDescription>You&apos;ll be the owner of a new tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* A social sign-up has no business form — the callback routes the
              new user to /new-business, which collects the same details. */}
          <SocialSignIn providers={providers} onError={toast.error} />
          {providers?.email === false ? (
            <p className="text-sm text-muted-foreground">
              Sign-up with a password is currently unavailable.
            </p>
          ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="business">Business name</Label>
              <Input
                id="business"
                required
                value={business}
                onChange={(e) => setBusiness(e.target.value)}
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
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
