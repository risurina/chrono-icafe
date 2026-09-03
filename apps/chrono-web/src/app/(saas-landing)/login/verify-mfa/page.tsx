"use client";

import { useState } from "react";
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

/**
 * Second step of staff sign-in when the account has TOTP enabled. The password
 * step (login page) returned a `twoFactorRedirect`; here we verify the code.
 */
export default function VerifyMfaPage() {
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setLoading(false);
    if (error) {
      toast.error("That code was not valid.");
      return;
    }
    location.href = "/dashboard";
  }

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Two-factor verification</CardTitle>
          <CardDescription>
            {useBackup
              ? "Enter one of your saved backup codes."
              : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="code">{useBackup ? "Backup code" : "Code"}</Label>
              <Input
                id="code"
                inputMode={useBackup ? "text" : "numeric"}
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying…" : "Verify"}
            </Button>
          </form>
          <Button
            variant="link"
            className="mt-2 px-0 text-sm"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode("");
            }}
          >
            {useBackup ? "Use an authenticator code" : "Use a backup code"}
          </Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
