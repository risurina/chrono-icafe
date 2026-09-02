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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";

type PublicInquiryCategory = "general" | "lost_and_found" | "feedback";

const CATEGORY_OPTIONS: { value: PublicInquiryCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "lost_and_found", label: "Lost and found" },
  { value: "feedback", label: "Feedback" },
];

export function ContactForm({
  tenantSlug,
  tenantHost,
}: {
  tenantSlug: string | null;
  tenantHost: string | null;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState<PublicInquiryCategory>("general");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !subject.trim() || !message.trim()) return;
    setSubmitting(true);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tenantSlug) headers["x-tenant-slug"] = tenantSlug;
    else if (tenantHost) headers["x-tenant-host"] = tenantHost;

    const res = await fetch(`${apiUrl}/public/inquiries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        submitterName: name.trim(),
        submitterEmail: email.trim(),
        submitterPhone: phone.trim() || undefined,
        category,
        subject: subject.trim(),
        message: message.trim(),
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? "Could not submit your message. Please try again.");
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Thanks for reaching out</CardTitle>
          <CardDescription>
            We&apos;ve received your message and will reply to your email as soon as we can.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact us</CardTitle>
        <CardDescription>Send us a question, a lost-and-found report, or feedback.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone (optional)</Label>
            <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as PublicInquiryCategory)}>
              <SelectTrigger id="category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="message">Message</Label>
            <Textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} required />
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
