"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Badge,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
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

type EmailIntegration = {
  provider: "resend" | "sendgrid";
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  enabled: boolean;
  hasApiKey: boolean;
} | null;

type StorageIntegration = {
  provider: "s3";
  bucket: string;
  region: string;
  endpoint: string | null;
  publicBaseUrl: string | null;
  accessKeyId: string;
  enabled: boolean;
  hasSecret: boolean;
  folder: string | null;
} | null;

/**
 * Settings → Integrations: connect the tenant's own providers (email + object
 * storage). Secrets are stored encrypted and never returned. The platform env
 * drivers stay the fallback when an integration is disabled/absent.
 */
export default function IntegrationsPage() {
  const [email, setEmail] = useState<EmailIntegration>(null);
  const [storage, setStorage] = useState<StorageIntegration>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Email form state
  const [provider, setProvider] = useState<"resend" | "sendgrid">("resend");
  const [apiKey, setApiKey] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [enabled, setEnabled] = useState(false);

  // Storage form state ("s3-compat" is a UI hint only; the wire provider is s3).
  const [storageMode, setStorageMode] = useState<"s3" | "s3-compat">("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [folder, setFolder] = useState("");

  async function load() {
    const res = await api.rpc.integrations.$get();
    if (res.ok) {
      const body = await res.json();
      const emailConn = body.email as EmailIntegration;
      setEmail(emailConn);
      if (emailConn) {
        setProvider(emailConn.provider);
        setFromAddress(emailConn.fromAddress);
        setFromName(emailConn.fromName ?? "");
        setReplyTo(emailConn.replyTo ?? "");
        setEnabled(emailConn.enabled);
      }
      const storageConn = body.storage as StorageIntegration;
      setStorage(storageConn);
      if (storageConn) {
        setStorageMode(storageConn.endpoint ? "s3-compat" : "s3");
        setBucket(storageConn.bucket);
        setRegion(storageConn.region);
        setEndpoint(storageConn.endpoint ?? "");
        setPublicBaseUrl(storageConn.publicBaseUrl ?? "");
        setAccessKeyId(storageConn.accessKeyId);
        setStorageEnabled(storageConn.enabled);
        setFolder(storageConn.folder ?? "");
      }
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can manage integrations.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function saveEmail(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const json: Record<string, unknown> = {
      provider,
      fromAddress,
      fromName: fromName || undefined,
      replyTo: replyTo || undefined,
      enabled,
    };
    // Only send the key when the admin actually typed one (keeps the stored one).
    if (apiKey) json.apiKey = apiKey;
    const res = await api.rpc.integrations.email.$put({ json: json as never });
    if (res.ok) {
      setApiKey("");
      load();
      setMsg("Email integration saved.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can manage integrations.");
    } else if ((res.status as number) === 400) {
      setMsg("An API key is required to create the integration.");
    } else {
      setMsg("Could not save the email integration.");
    }
  }

  async function testEmail() {
    setMsg(null);
    const res = await api.rpc.integrations.email.test.$post();
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; provider: string };
      setMsg(`Test email sent via ${body.provider}.`);
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can send a test email.");
    } else {
      setMsg("Could not send the test email.");
    }
  }

  async function deleteEmail() {
    setMsg(null);
    const res = await api.rpc.integrations.email.$delete();
    if (res.ok) {
      setEmail(null);
      setProvider("resend");
      setApiKey("");
      setFromAddress("");
      setFromName("");
      setReplyTo("");
      setEnabled(false);
      setMsg("Email integration removed.");
    } else {
      setMsg("Could not remove the email integration.");
    }
  }

  async function saveStorage(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const json: Record<string, unknown> = {
      provider: "s3",
      bucket,
      region,
      accessKeyId,
      endpoint: endpoint || undefined,
      publicBaseUrl: publicBaseUrl || undefined,
      enabled: storageEnabled,
      folder: folder || undefined,
    };
    // Only send the secret when the admin actually typed one (keeps the stored one).
    if (secretAccessKey) json.secretAccessKey = secretAccessKey;
    const res = await api.rpc.integrations.storage.$put({ json: json as never });
    if (res.ok) {
      setSecretAccessKey("");
      load();
      setMsg("Storage integration saved.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can manage integrations.");
    } else if ((res.status as number) === 400) {
      setMsg(
        "Check the fields: a secret access key is required to create the integration, and the endpoint/public URL must be public https.",
      );
    } else {
      setMsg("Could not save the storage integration.");
    }
  }

  async function testStorage() {
    setMsg(null);
    const res = await api.rpc.integrations.storage.test.$post();
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; provider: string };
      setMsg(`Storage connection ok (provider: ${body.provider}).`);
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can test the storage connection.");
    } else {
      setMsg("Storage connection test failed — check the bucket and keys.");
    }
  }

  async function deleteStorage() {
    setMsg(null);
    const res = await api.rpc.integrations.storage.$delete();
    if (res.ok) {
      setStorage(null);
      setStorageMode("s3");
      setBucket("");
      setRegion("");
      setEndpoint("");
      setPublicBaseUrl("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setStorageEnabled(false);
      setFolder("");
      setMsg("Storage integration removed.");
    } else {
      setMsg("Could not remove the storage integration.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect your own providers. Keys are stored encrypted and never shown again
          after saving.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>
            Send transactional email (invites, notifications) through your own provider.
            When disabled, the platform default is used.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={saveEmail} className="space-y-4">
            <Field>
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as "resend" | "sendgrid")}
              >
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="resend">Resend</SelectItem>
                  <SelectItem value="sendgrid">SendGrid</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder={email?.hasApiKey ? "•••••••• (leave blank to keep)" : ""}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted. It is never shown again after saving.
              </p>
            </Field>
            <Field>
              <Label htmlFor="fromAddress">From address</Label>
              <Input
                id="fromAddress"
                type="email"
                placeholder="no-reply@acme.com"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="fromName">From name</Label>
              <Input
                id="fromName"
                placeholder="Acme"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="replyTo">Reply-to (optional)</Label>
              <Input
                id="replyTo"
                type="email"
                placeholder="support@acme.com"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
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
              <Button type="submit">Save integration</Button>
              <Button type="button" variant="outline" onClick={testEmail}>
                Send test email
              </Button>
              {email ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={deleteEmail}
                >
                  Remove
                </Button>
              ) : null}
            </Row>
          </form>
        </CardContent>
        <CardFooter>
          <Badge variant={email?.enabled ? "success" : "secondary"}>
            {email
              ? email.enabled
                ? `Enabled — ${email.provider}`
                : `Configured — ${email.provider} (disabled)`
              : "Not configured (using platform default)"}
          </Badge>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>
            Store uploaded assets (logos, favicons) in your own S3-compatible bucket —
            your region, your keys. When disabled, the platform default bucket is used.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={saveStorage} className="space-y-4">
            <Field>
              <Label htmlFor="storageProvider">Provider</Label>
              <Select
                value={storageMode}
                onValueChange={(v) => setStorageMode(v as "s3" | "s3-compat")}
              >
                <SelectTrigger id="storageProvider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="s3">Amazon S3</SelectItem>
                  <SelectItem value="s3-compat">
                    S3-compatible (Cloudflare R2 / MinIO / Backblaze B2)
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="bucket">Bucket</Label>
              <Input
                id="bucket"
                placeholder="acme-assets"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="region">Region</Label>
              <Input
                id="region"
                placeholder="us-east-1"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="endpoint">
                Endpoint {storageMode === "s3" ? "(optional)" : ""}
              </Label>
              <Input
                id="endpoint"
                placeholder="https://<account>.r2.cloudflarestorage.com"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank for Amazon S3. Required for R2/MinIO/B2. Must be a public
                https URL.
              </p>
            </Field>
            <Field>
              <Label htmlFor="publicBaseUrl">Public base URL / CDN (optional)</Label>
              <Input
                id="publicBaseUrl"
                placeholder="https://cdn.acme.com"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="folder">Upload folder</Label>
              <Input
                id="folder"
                placeholder="my-workspace"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                All this workspace's uploads are stored under this folder.
              </p>
            </Field>
            <Field>
              <Label htmlFor="accessKeyId">Access key ID</Label>
              <Input
                id="accessKeyId"
                placeholder="AKIA…"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="secretAccessKey">Secret access key</Label>
              <Input
                id="secretAccessKey"
                type="password"
                placeholder={
                  storage?.hasSecret ? "•••• stored (leave blank to keep)" : ""
                }
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted. It is never shown again after saving.
              </p>
            </Field>
            <ListRow
              actions={
                <Button
                  type="button"
                  variant={storageEnabled ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStorageEnabled((v) => !v)}
                >
                  {storageEnabled ? "On" : "Off"}
                </Button>
              }
            >
              <p className="text-sm font-medium">Enabled</p>
            </ListRow>
            <Row>
              <Button type="submit">Save integration</Button>
              <Button type="button" variant="outline" onClick={testStorage}>
                Test connection
              </Button>
              {storage ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={deleteStorage}
                >
                  Remove
                </Button>
              ) : null}
            </Row>
          </form>
        </CardContent>
        <CardFooter>
          <Badge variant={storage?.enabled ? "success" : "secondary"}>
            {storage
              ? storage.enabled
                ? `Enabled — ${storage.bucket} (${storage.region})`
                : `Configured — ${storage.bucket} (disabled)`
              : "Not configured (using platform default)"}
          </Badge>
        </CardFooter>
      </Card>
    </Stack>
  );
}
