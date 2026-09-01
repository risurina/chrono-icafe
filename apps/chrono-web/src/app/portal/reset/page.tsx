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

/** Customer reset page — consumes the token from the emailed link. */
export default function PortalResetPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      toast.error("This reset link is missing its token.");
      return;
    }
    setLoading(true);
    const { error } = await memberAuth.reset({ token, password });
    if (error) {
      toast.error(error);
      setLoading(false);
      return;
    }
    setDone(true);
    setTimeout(() => (window.location.href = "/portal/login"), 900);
  }

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <p className="text-sm text-muted-foreground">
              Password updated — taking you to sign in…
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field>
                <Label htmlFor="password">New password</Label>
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
                {loading ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            <Link href="/portal/login" className="text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
