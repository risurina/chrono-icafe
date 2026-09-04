"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Input,
  Label,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Stack,
  Row,
} from "agora/ui";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/rpc";

/**
 * Self-service TOTP enrollment. Uses the Better Auth twoFactor client:
 *   enable({ password }) → { totpURI, backupCodes } → verifyTotp({ code }).
 * We render the otpauth:// URI + secret for manual entry (no QR dependency).
 */
export default function MfaEnrollPage() {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.rpc.security.mfa.$get().then(async (r) => {
      if (r.ok) setEnrolled((await r.json()).enrolled);
    });
  }, []);

  const secret = totpUri ? new URL(totpUri).searchParams.get("secret") : null;

  async function startEnroll(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (error || !data) {
      setMsg(error?.message ?? "Could not start enrollment. Check your password.");
      return;
    }
    setTotpUri(data.totpURI);
    setBackupCodes(data.backupCodes ?? []);
    setMsg("Scan the code in your authenticator, then enter a 6-digit code below.");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (error) {
      setMsg("That code was not valid. Try the current code from your app.");
      return;
    }
    setEnrolled(true);
    setTotpUri(null);
    setCode("");
    setMsg("Two-factor authentication is now enabled.");
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const { error } = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (error) {
      setMsg(error.message ?? "Could not disable. Check your password.");
      return;
    }
    setEnrolled(false);
    setPassword("");
    setMsg("Two-factor authentication disabled.");
  }

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Two-factor authentication
        </h1>
        <p className="text-sm text-muted-foreground">
          Use an authenticator app (TOTP) as a second factor.{" "}
          <Link
            href="/admin/settings/security"
            className="text-primary hover:underline"
          >
            Back to Security
          </Link>
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Status
            <Badge variant={enrolled ? "success" : "warning"}>
              {enrolled == null ? "…" : enrolled ? "Enrolled" : "Not enrolled"}
            </Badge>
          </CardTitle>
          <CardDescription>
            {enrolled
              ? "Your account is protected by TOTP."
              : "Confirm your password to begin enrollment."}
          </CardDescription>
        </CardHeader>

        {!enrolled && !totpUri ? (
          <CardContent>
            <form onSubmit={startEnroll} className="space-y-4">
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
              <Button type="submit" disabled={busy}>
                {busy ? "Starting…" : "Start enrollment"}
              </Button>
            </form>
          </CardContent>
        ) : null}

        {totpUri ? (
          <CardContent className="space-y-4">
            <Field>
              <Label>Secret (manual entry)</Label>
              <Input readOnly value={secret ?? ""} className="font-mono" />
              <p className="break-all text-xs text-muted-foreground">{totpUri}</p>
            </Field>
            {backupCodes.length > 0 ? (
              <Field>
                <Label>Backup codes (save these now — shown once)</Label>
                <div className="grid grid-cols-2 gap-1 rounded-md border p-3 font-mono text-xs">
                  {backupCodes.map((b) => (
                    <span key={b}>{b}</span>
                  ))}
                </div>
              </Field>
            ) : null}
            <form onSubmit={verify} className="space-y-2">
              <Label htmlFor="code">Enter a 6-digit code</Label>
              <Row>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
                <Button type="submit" disabled={busy}>
                  Verify
                </Button>
              </Row>
            </form>
          </CardContent>
        ) : null}

        {enrolled ? (
          <CardContent>
            <form onSubmit={disable} className="space-y-4">
              <Field>
                <Label htmlFor="dpassword">Password</Label>
                <Input
                  id="dpassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="outline"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
              >
                Disable two-factor
              </Button>
            </form>
          </CardContent>
        ) : null}

        <CardFooter>
          <p className="text-xs text-muted-foreground">
            If your tenant requires MFA, you must complete enrollment to reach the
            dashboard.
          </p>
        </CardFooter>
      </Card>
    </Stack>
  );
}
