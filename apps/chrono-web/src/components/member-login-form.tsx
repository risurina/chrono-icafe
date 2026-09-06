"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
  MemberSocialSignIn,
  useMemberAuthProviders,
  Row,
  Separator,
  toast,
} from "agora/ui";
import { safeNextPath, describeMemberAuthError } from "agora/client";
import { memberAuth } from "@/lib/member-client";
import { track } from "@/lib/analytics";
import { TenantBrandHeader } from "@/components/tenant-brand-header";

/**
 * Customer ("member") sign-in for this business — the tenant-scoped
 * `tenantMember` pool via `memberAuth`. Rendered at a tenant host's `/login`;
 * lands in the member area (or `?next=` when set, e.g. a QR scan).
 */
export function MemberLoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const providers = useMemberAuthProviders();
  const next = safeNextPath(searchParams.get("next")) ?? "/member";

  // Surface an error handed back by the OAuth round trip (e.g. the deliberate
  // account_not_linked refusal) rather than dropping the user on a blank form.
  useEffect(() => {
    const code = searchParams.get("error");
    if (code) toast.error(describeMemberAuthError(code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await memberAuth.signIn({ email, password });
    if (error) {
      toast.error(error);
      setLoading(false);
      return;
    }
    track("PLAYER_LOGIN_FROM_TENANT", {});
    location.href = next;
  }

  return (
    <AuthLayout inset>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Customer sign in</CardTitle>
          <CardDescription>Access your member area.</CardDescription>
        </CardHeader>
        <CardContent>
          <MemberSocialSignIn providers={providers} next={next} />
          {providers && providers.social.length > 0 ? (
            <Row items="center" gap={3} className="mb-4">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">OR</span>
              <Separator className="flex-1" />
            </Row>
          ) : null}
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
          <p className="mt-4 text-sm text-muted-foreground">
            <Link href="/portal/forgot" className="text-primary hover:underline">
              Forgot password?
            </Link>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/portal/sign-up" className="text-primary hover:underline">
              Create one
            </Link>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Staff member?{" "}
            <Link href="/admin/login" className="text-primary hover:underline">
              Staff sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
