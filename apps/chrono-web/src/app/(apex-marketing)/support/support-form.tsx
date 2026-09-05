"use client";

import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Label,
  Input,
  Textarea,
  toast,
} from "agora/ui";

/**
 * The real support/lead-capture form — posts to
 * `POST /public/company-inquiries` (`apps/chrono-api/src/modules/
 * company-inquiry`) with `source: "support"`, mirroring the tenant
 * `ContactForm`'s (`apps/chrono-web/src/app/(saas-landing)/contact/
 * client.tsx`) fetch pattern minus the tenant headers — none apply on the
 * apex, unauthenticated surface.
 */
export function SupportForm() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [requestType, setRequestType] = useState("");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !requestType.trim() || !message.trim()) return;
    setSubmitting(true);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    const res = await fetch(`${apiUrl}/public/company-inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        businessName: businessName.trim() || undefined,
        requestType: requestType.trim(),
        message: message.trim(),
        source: "support",
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not send your message. Please try again.");
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Message sent</CardTitle>
          <CardDescription>
            Thank you for reaching out. We&apos;ve received your request and
            will respond with the next best step shortly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => setSubmitted(false)}>
            Send another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a support request</CardTitle>
        <CardDescription>
          The IZUR team will review your request and respond with the next
          best step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="support-name">Name</Label>
            <Input
              id="support-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-email">Email</Label>
            <Input
              id="support-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="support-business">Cafe / business name</Label>
              <Input
                id="support-business"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-request-type">Request type</Label>
              <Input
                id="support-request-type"
                placeholder="Demo, Setup, etc."
                value={requestType}
                onChange={(e) => setRequestType(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-message">Message</Label>
            <Textarea
              id="support-message"
              placeholder="How can we help?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Sending…" : "Submit request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
