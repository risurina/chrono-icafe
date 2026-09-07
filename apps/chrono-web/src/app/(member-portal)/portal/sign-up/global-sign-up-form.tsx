"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { track } from "@/lib/analytics";
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

/** Global customer registration — platform-wide identity, not tied to a tenant. */
export function GlobalSignUpForm() {
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const providers = useCustomerAuthProviders();

  // Surface an error handed back by the OAuth round trip — Google/Facebook
  // "sign up" and "sign in" share the same callback, so a new customer can
  // land here too (e.g. account_not_linked when the email already has a
  // password).
  useEffect(() => {
    const code = searchParams.get("error") as CustomerOAuthErrorCode | null;
    const message = describeCustomerAuthError(code);
    if (message) toast.error(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await customerAuth.signUp({ name, email, password });
    if (error) {
      toast.error(error);
      setLoading(false);
      return;
    }
    track("PLAYER_SIGNUP");
    location.href = "/portal";
  }

  return (
    <AuthLayout inset>
      <Card>
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            One account, usable across every business you join.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomerSocialSignIn providers={providers} next="/portal" />
          {providers && providers.social.length > 0 ? (
            <Row items="center" gap={3} className="mb-4">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">OR</span>
              <Separator className="flex-1" />
            </Row>
          ) : null}
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
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating…" : "Create account"}
            </Button>
          </form>
          <p className="mt-4 text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/portal/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
