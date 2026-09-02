"use client";

import { useState } from "react";
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
  toast,
} from "agora/ui";
import { safeNextPath } from "agora/client";
import { memberAuth } from "@/lib/member-client";
import { TenantBrandHeader } from "@/components/tenant-brand-header";

/** Customer ("member") login → member area (or `?next=` when set, e.g. a QR scan). */
export default function PortalLoginPage() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await memberAuth.signIn({ email, password });
    if (error) {
      toast.error(error);
      setLoading(false);
      return;
    }
    location.href = safeNextPath(searchParams.get("next")) ?? "/portal";
  }

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Customer sign in</CardTitle>
          <CardDescription>Access your member area.</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
