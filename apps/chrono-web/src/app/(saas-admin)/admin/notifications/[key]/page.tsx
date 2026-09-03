"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Label,
  Input,
  Textarea,
  Button,
  Badge,
  Stack,
  Row,
  Can,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { useSession } from "@/lib/auth-client";
import type { NotificationTemplateKey, NotificationTemplateState } from "agora";
import { usePlatformPermissions } from "../../layout";

/** Required tokens (per the registry) missing as literal `{{token}}` text. */
function missingPlaceholders(required: string[], bodyHtml: string): string[] {
  return required.filter((token) => !bodyHtml.includes(`{{${token}}}`));
}

export default function NotificationTemplateEditPage() {
  const permissions = usePlatformPermissions();
  const { data: session } = useSession();
  const params = useParams<{ key: string }>();
  const key = params.key as NotificationTemplateKey;

  const [template, setTemplate] = useState<NotificationTemplateState | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [showTestPrompt, setShowTestPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["notification-templates"][":key"].$get({
      param: { key },
    });
    if (!res.ok) {
      setError("Could not load this template.");
      toast.error("Could not load this template.");
      return;
    }
    const state = (await res.json()) as NotificationTemplateState;
    setTemplate(state);
    setSubject(state.subject);
    setBodyHtml(state.bodyHtml);
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (session?.user?.email) setTestEmail(session.user.email);
  }, [session]);

  if (!template) {
    return (
      <Stack gap={6}>
        {!error && <p className="text-sm text-muted-foreground">Loading…</p>}
      </Stack>
    );
  }

  // Client-side mirror of the server's required-placeholder check — doesn't
  // replace it, just gives faster feedback before Save is even clicked.
  const clientMissing = missingPlaceholders(template.requiredPlaceholders, bodyHtml);

  async function handleSave() {
    setError(null);
    setSaving(true);
    const res = await adminApi["rpc-admin"]["notification-templates"][":key"].$put({
      param: { key },
      json: { subject, bodyHtml },
    });
    setSaving(false);
    if (res.ok) {
      const state = (await res.json()) as NotificationTemplateState;
      setTemplate(state);
      toast.success("Template saved.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const errorMsg = body?.error ?? "Could not save this template.";
    setError(errorMsg);
    toast.error(errorMsg);
  }

  async function handleSendTest() {
    setError(null);
    setSendingTest(true);
    const res = await adminApi["rpc-admin"]["notification-templates"][":key"][
      "test"
    ].$post({
      param: { key },
      json: { toEmail: testEmail, subject, bodyHtml },
    });
    setSendingTest(false);
    setShowTestPrompt(false);
    if (res.ok) {
      toast.success(`Test email sent to ${testEmail} using the current draft.`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const errorMsg = body?.error ?? "Could not send the test email.";
    setError(errorMsg);
    toast.error(errorMsg);
  }

  async function handleRestore() {
    setError(null);
    setRestoring(true);
    const res = await adminApi["rpc-admin"]["notification-templates"][":key"].$delete({
      param: { key },
    });
    setRestoring(false);
    setConfirmRestore(false);
    if (res.ok) {
      const state = (await res.json()) as NotificationTemplateState;
      setTemplate(state);
      setSubject(state.subject);
      setBodyHtml(state.bodyHtml);
      toast.success("Restored to the default template.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const errorMsg = body?.error ?? "Could not restore the default template.";
    setError(errorMsg);
    toast.error(errorMsg);
  }

  return (
    <Stack gap={6}>
      <div>
        <Link href="/admin/notifications" className="text-sm text-muted-foreground hover:underline">
          ← Notification templates
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{template.label}</h1>
          {template.isOverridden ? (
            <Badge variant="secondary">Customized</Badge>
          ) : (
            <Badge variant="outline">Default</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{template.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to staff/account-holder emails only — does not affect tenant customer
          password-reset emails.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Content</CardTitle>
          <CardDescription>
            Available placeholders:{" "}
            {template.requiredPlaceholders.map((p) => `{{${p}}}`).join(", ")}. Every
            one listed must appear in the body.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={
                !permissions.notification?.includes("manage")
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bodyHtml">Body (HTML)</Label>
            <Textarea
              id="bodyHtml"
              rows={14}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              disabled={!permissions.notification?.includes("manage")}
              className="font-mono text-sm"
            />
            {clientMissing.length > 0 ? (
              <p className="text-xs text-destructive">
                Missing required placeholder(s):{" "}
                {clientMissing.map((t) => `{{${t}}}`).join(", ")}
              </p>
            ) : null}
          </div>
        </CardContent>
        <CardFooter>
          <Can permissions={permissions} resource="notification" action="manage">
            <Row gap={2}>
              <Button
                variant="outline"
                onClick={() => setShowTestPrompt(true)}
                disabled={sendingTest || clientMissing.length > 0}
              >
                Send test email
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || clientMissing.length > 0}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmRestore(true)}
                disabled={restoring || !template.isOverridden}
              >
                Restore default
              </Button>
            </Row>
          </Can>
        </CardFooter>
      </Card>

      <Dialog open={showTestPrompt} onOpenChange={setShowTestPrompt}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Sends the current, possibly-unsaved draft above — not the last saved
              content — using sample placeholder values.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="testEmail">Send to</Label>
            <Input
              id="testEmail"
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTestPrompt(false)}>
              Cancel
            </Button>
            <Button onClick={handleSendTest} disabled={sendingTest || !testEmail}>
              {sendingTest ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore default template?</DialogTitle>
            <DialogDescription>
              This discards the saved custom copy for &quot;{template.label}&quot; and
              reverts to the built-in default. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestore(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restoring…" : "Restore default"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
