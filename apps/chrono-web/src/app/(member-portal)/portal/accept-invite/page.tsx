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
import { memberAuth } from "@/lib/member-client";
import { TenantBrandHeader } from "@/components/tenant-brand-header";

/** Customer accept-invite page — consumes a staff-issued invite link, sets a
 * password, and signs the customer straight in (the invite already implies
 * approval, unlike /portal/reset which never authenticates the caller). */
export default function AcceptInvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      toast.error("This invite link is missing its token.");
      return;
    }
    setLoading(true);
    const { error } = await memberAuth.acceptInvite({ token, password });
    if (error) {
      toast.error(error);
      setInvalid(true);
      setLoading(false);
      return;
    }
    window.location.href = "/portal";
  }

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>You&apos;re invited</CardTitle>
          <CardDescription>Set a password to activate your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {invalid ? (
            <p className="text-sm text-muted-foreground">
              This invite link is invalid or has expired. Contact the business for a new
              one, or{" "}
              <Link href="/login" className="text-primary hover:underline">
                sign in
              </Link>{" "}
              if you already have an account.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
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
                {loading ? "Activating…" : "Activate account"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
