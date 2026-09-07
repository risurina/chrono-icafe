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
  CustomerSocialSignIn,
  useCustomerAuthProviders,
  Row,
  Separator,
  toast,
} from "agora/ui";
import { describeCustomerAuthError } from "agora/client";
import type { CustomerOAuthErrorCode } from "agora";
import { customerAuth } from "@/lib/customer-client";

/** Global customer sign-in — platform-wide identity, not tied to a tenant. */
export function GlobalLoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const providers = useCustomerAuthProviders();

  // Surface an error handed back by the OAuth round trip (e.g. the deliberate
  // account_not_linked refusal) rather than dropping the user on a blank form.
  useEffect(() => {
    const code = searchParams.get("error") as CustomerOAuthErrorCode | null;
    const message = describeCustomerAuthError(code);
    if (message) toast.error(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await customerAuth.signIn({ email, password });
    if (error) {
      toast.error(error);
      setLoading(false);
      return;
    }
    location.href = "/member";
  }

  return (
    <AuthLayout inset>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Access your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <CustomerSocialSignIn providers={providers} next="/member" />
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
            <Link href="/member/forgot" className="text-primary hover:underline">
              Forgot password?
            </Link>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/member/sign-up" className="text-primary hover:underline">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
