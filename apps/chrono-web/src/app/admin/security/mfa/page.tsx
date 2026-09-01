"use client";

import { useCallback, useEffect, useState } from "react";
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
import { authClient, useSession } from "@/lib/auth-client";
import { adminApi } from "@/lib/admin-client";
import { useAuthProviders } from "@/components/social-sign-in";

/** Better Auth stores the password credential under the provider id "credential". */
const CREDENTIAL_PROVIDER = "credential";

/**
 * Platform-surface TOTP enrollment (Blocker 3 of the platform-security-policy
 * plan). Deliberately its own route under `/admin`, not nested under
 * `/dashboard`: a platform-role-only account has no tenant `member` row and
 * so cannot reach the tenant dashboard's `security/mfa` page at all. Status
 * is read from the new `GET /rpc-admin/security/mfa` route (not the tenant
 * `/rpc/security/mfa`, which is unreachable with no tenant host); the
 * enroll/verify/disable calls go straight through Better Auth's own
 * `authClient.twoFactor.*` endpoints, unchanged from the tenant page.
 *
 * No nav entry for this page by design (Phase 3 decision) — it is reachable
 * only via the enforcement redirect (`platform_2fa_required`) and a link
 * from the main `/admin/security` settings page.
 */
export default function PlatformMfaEnrollPage() {
  const { data: session } = useSession();
  const providers = useAuthProviders();
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [hasCredential, setHasCredential] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["security"]["mfa"].$get();
    if (res.ok) setEnrolled((await res.json()).enrolled);

    const accountsRes = await authClient.listAccounts();
    if (!accountsRes.error) {
      setHasCredential(
        (accountsRes.data ?? []).some((a) => a.providerId === CREDENTIAL_PROVIDER),
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const secret = totpUri ? new URL(totpUri).searchParams.get("secret") : null;
  // Social-only-admin remedy (Blocker 3, Condition 2): the only real path to
  // a credential account is the existing password-reset-request flow.
  const emailAvailable = providers?.email ?? true;

  async function requestPasswordReset() {
    if (!session?.user.email) return;
    setMsg(null);
    setBusy(true);
    await authClient.requestPasswordReset({
      email: session.user.email,
      redirectTo: "/admin/security/mfa",
    });
    setBusy(false);
    setResetSent(true);
  }

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
          Platform two-factor authentication
        </h1>
        <p className="text-sm text-muted-foreground">
          Use an authenticator app (TOTP) as a second factor for platform-admin access.{" "}
          <Link href="/admin/security" className="text-primary hover:underline">
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
              ? "Your platform-admin account is protected by TOTP."
              : "Confirm your password to begin enrollment."}
          </CardDescription>
        </CardHeader>

        {hasCredential === false ? (
          <CardContent className="space-y-3">
            {!emailAvailable ? (
              <p className="text-sm text-muted-foreground">
                You signed in with a social provider only, and the platform&apos;s
                email sign-in method is currently disabled, so there is no path to
                enroll right now — you cannot set a password until email sign-in is
                re-enabled. Ask another platform admin to re-enable it under
                Sign-in methods.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  You signed in with Google/Facebook only, so you have no password to
                  confirm with. We can send a password-reset email — set a password,
                  then come back here to enroll in 2FA.
                </p>
                <Button onClick={requestPasswordReset} disabled={busy || resetSent}>
                  {resetSent ? "Reset email sent" : "Send password-reset email"}
                </Button>
              </>
            )}
          </CardContent>
        ) : null}

        {!enrolled && !totpUri && hasCredential !== false ? (
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
            If the platform requires 2FA for admin accounts, you must complete
            enrollment to reach `/admin`/`/rpc-admin` again.
          </p>
        </CardFooter>
      </Card>
    </Stack>
  );
}
