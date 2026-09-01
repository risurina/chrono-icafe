"use client";

import { useEffect, useState } from "react";
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
  AuthLayout,
  toast,
} from "agora/ui";
import { authClient } from "@/lib/auth-client";
import { TenantBrandHeader } from "@/components/tenant-brand-header";
import { SocialSignIn, useAuthProviders } from "@/components/social-sign-in";
import { resolveLandingUrl, describeAuthError } from "@/lib/post-auth";

/** Staff / admin login. Lives on a tenant subdomain → back-office dashboard. */
export default function StaffLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; required: boolean }>({
    enabled: false,
    required: false,
  });
  const providers = useAuthProviders();

  // Surface an error handed back by the OAuth round trip (e.g. the deliberate
  // account_not_linked refusal) rather than dropping the user on a blank form.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) toast.error(describeAuthError(code));
  }, []);

  // Pre-auth hint: does this tenant offer / require SSO? Drives the SSO button
  // and whether password login stays visible.
  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    fetch(`${apiUrl}/public/sso`, {
      headers: { "x-tenant-host": window.location.host },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b?.sso && setSso(b.sso))
      .catch(() => {});
  }, []);

  async function startSso() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    const res = await fetch(`${apiUrl}/public/sso/start`, {
      headers: { "x-tenant-host": window.location.host },
    });
    if (!res.ok) {
      toast.error("SSO is not available for this workspace.");
      return;
    }
    const body = (await res.json()) as { authorizationUrl: string };
    window.location.href = body.authorizationUrl;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await authClient.signIn.email({ email, password });
    if (error) {
      toast.error(error.message ?? "Sign in failed");
      setLoading(false);
      return;
    }
    // The twoFactor plugin returns a redirect marker instead of a session when
    // the account has TOTP enabled — send them to the verification step.
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      location.href = "/login/verify-mfa";
      return;
    }
    // One shared resolver for every sign-in path: a safe same-origin ?next= on
    // a tenant host, else the first workspace's dashboard, else workspace
    // creation. The last case is why this is shared — the apex used to send a
    // user with no workspaces to /dashboard, a host with no tenant.
    location.href = await resolveLandingUrl();
  }

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Staff sign in</CardTitle>
          <CardDescription>Back-office access for this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {sso.enabled ? (
            <div className="mb-4 space-y-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={startSso}
              >
                Sign in with SSO
              </Button>
              {sso.required ? (
                <p className="text-center text-xs text-muted-foreground">
                  This workspace requires single sign-on.
                </p>
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  or use your password
                </p>
              )}
            </div>
          ) : null}
          <SocialSignIn providers={providers} onError={toast.error} />
          {sso.required || providers?.email === false ? null : (
            <form onSubmit={onSubmit} className="space-y-4">
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
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}
          {providers?.email === false ? (
            <p className="text-sm text-muted-foreground">
              Password sign-in is currently unavailable.
            </p>
          ) : null}
          <p className="mt-4 text-sm text-muted-foreground">
            <Link href="/forgot-password" className="text-primary hover:underline">
              Forgot password?
            </Link>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Are you a customer?{" "}
            <Link href="/portal/login" className="text-primary hover:underline">
              Customer sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
