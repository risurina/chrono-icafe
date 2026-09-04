"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  buttonVariants,
  Input,
  Label,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  ListRow,
  Field,
  Stack,
  Row,
} from "agora/ui";
import { api } from "@/lib/rpc";
import { LinkedAccounts } from "@/components/linked-accounts";

type Policy = {
  ssoRequired: boolean;
  mfaRequired: boolean;
  defaultSsoRole: string;
};
type SsoConnection = {
  issuer: string;
  clientId: string;
  allowedDomain: string | null;
  defaultRole: string;
  enabled: boolean;
  hasClientSecret: boolean;
} | null;

/** Settings → Security: MFA policy, MFA enrollment, and the tenant SSO connection. */
export default function SecurityPage() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [sso, setSso] = useState<SsoConnection>(null);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // SSO form state
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [allowedDomain, setAllowedDomain] = useState("");
  const [enabled, setEnabled] = useState(false);

  async function loadAll() {
    const [p, s, m] = await Promise.all([
      api.rpc.security.policy.$get(),
      api.rpc.security.sso.$get(),
      api.rpc.security.mfa.$get(),
    ]);
    if (p.ok) setPolicy((await p.json()).policy as Policy);
    if (s.ok) {
      const conn = (await s.json()).connection as SsoConnection;
      setSso(conn);
      if (conn) {
        setIssuer(conn.issuer);
        setClientId(conn.clientId);
        setAllowedDomain(conn.allowedDomain ?? "");
        setEnabled(conn.enabled);
      }
    }
    if (m.ok) setMfaEnrolled((await m.json()).enrolled);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function savePolicy(patch: { ssoRequired?: boolean; mfaRequired?: boolean }) {
    setMsg(null);
    const res = await api.rpc.security.policy.$put({ json: patch });
    if (res.ok) {
      setPolicy((await res.json()).policy as Policy);
      setMsg("Security policy updated.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can change the security policy.");
    } else {
      setMsg("Could not update the security policy.");
    }
  }

  async function saveSso(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const json: Record<string, unknown> = {
      issuer,
      clientId,
      allowedDomain: allowedDomain || null,
      enabled,
    };
    // Only send the secret when the admin actually typed one (keeps the stored
    // one on update).
    if (clientSecret) json.clientSecret = clientSecret;
    const res = await api.rpc.security.sso.$put({ json: json as never });
    if (res.ok) {
      setClientSecret("");
      loadAll();
      setMsg("SSO connection saved.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can configure SSO.");
    } else if ((res.status as number) === 400) {
      setMsg("A client secret is required to create the connection.");
    } else {
      setMsg("Could not save the SSO connection.");
    }
  }

  async function testSso() {
    setMsg(null);
    const res = await api.rpc.security.sso.test.$post();
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; discoveryUrl: string };
      setMsg(
        body.ok
          ? `Connection looks valid. Discovery: ${body.discoveryUrl}`
          : "Connection is incomplete — check issuer, client id and secret.",
      );
    } else {
      setMsg("No SSO connection to test yet.");
    }
  }

  async function deleteSso() {
    setMsg(null);
    const res = await api.rpc.security.sso.$delete();
    if (res.ok) {
      setSso(null);
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setAllowedDomain("");
      setEnabled(false);
      setMsg("SSO connection removed.");
    } else {
      setMsg("Could not remove the SSO connection.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          Multi-factor authentication and single sign-on for staff.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* MFA enrollment (self-service) */}
      <Card>
        <CardHeader>
          <CardTitle>Your two-factor authentication</CardTitle>
          <CardDescription>
            Protect your own account with an authenticator app (TOTP).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <Badge variant={mfaEnrolled ? "success" : "warning"}>
            {mfaEnrolled ? "Enrolled" : "Not enrolled"}
          </Badge>
          <Link
            href="/admin/settings/security/mfa"
            className={buttonVariants({ variant: "outline" })}
          >
            {mfaEnrolled ? "Manage" : "Enroll"}
          </Link>
        </CardContent>
      </Card>

      {/* Tenant MFA / SSO policy (admin) */}
      <Card>
        <CardHeader>
          <CardTitle>Policy</CardTitle>
          <CardDescription>
            Tenant-wide requirements for staff (admin only).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ListRow
            actions={
              <Button
                variant={policy?.mfaRequired ? "default" : "outline"}
                size="sm"
                onClick={() => savePolicy({ mfaRequired: !policy?.mfaRequired })}
              >
                {policy?.mfaRequired ? "Required" : "Optional"}
              </Button>
            }
          >
            <div>
              <p className="text-sm font-medium">Require MFA</p>
              <p className="text-xs text-muted-foreground">
                Staff must enroll TOTP before reaching the dashboard.
              </p>
            </div>
          </ListRow>
          <ListRow
            actions={
              <Button
                variant={policy?.ssoRequired ? "default" : "outline"}
                size="sm"
                onClick={() => savePolicy({ ssoRequired: !policy?.ssoRequired })}
              >
                {policy?.ssoRequired ? "Required" : "Optional"}
              </Button>
            }
          >
            <div>
              <p className="text-sm font-medium">Require SSO</p>
              <p className="text-xs text-muted-foreground">
                Staff must sign in through your identity provider.
              </p>
            </div>
          </ListRow>
        </CardContent>
      </Card>

      {/* SSO connection (admin) */}
      <Card>
        <CardHeader>
          <CardTitle>Single sign-on (OIDC)</CardTitle>
          <CardDescription>
            Connect your identity provider (Okta, Entra, Google Workspace, …).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={saveSso} className="space-y-4">
            <Field>
              <Label htmlFor="issuer">Issuer URL</Label>
              <Input
                id="issuer"
                placeholder="https://acme.okta.com"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="clientId">Client ID</Label>
              <Input
                id="clientId"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="clientSecret">Client secret</Label>
              <Input
                id="clientSecret"
                type="password"
                placeholder={
                  sso?.hasClientSecret ? "•••••••• (leave blank to keep)" : ""
                }
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted. It is never shown again after saving.
              </p>
            </Field>
            <Field>
              <Label htmlFor="allowedDomain">Allowed email domain</Label>
              <Input
                id="allowedDomain"
                placeholder="acme.com"
                value={allowedDomain}
                onChange={(e) => setAllowedDomain(e.target.value)}
              />
            </Field>
            <ListRow
              actions={
                <Button
                  type="button"
                  variant={enabled ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEnabled((v) => !v)}
                >
                  {enabled ? "On" : "Off"}
                </Button>
              }
            >
              <p className="text-sm font-medium">Enabled</p>
            </ListRow>
            <Row>
              <Button type="submit">Save connection</Button>
              <Button type="button" variant="outline" onClick={testSso}>
                Test connection
              </Button>
              {sso ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={deleteSso}
                >
                  Remove
                </Button>
              ) : null}
            </Row>
          </form>
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            {sso
              ? `Configured: ${sso.issuer}${sso.enabled ? " (enabled)" : " (disabled)"}`
              : "No SSO connection configured yet."}
          </p>
        </CardFooter>
      </Card>

      <LinkedAccounts />
    </Stack>
  );
}
