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

const MESSAGE_MAX_LENGTH = 2000;

interface FieldErrors {
  name?: string;
  email?: string;
  message?: string;
  numberOfPcs?: string;
  numberOfBranches?: string;
}

/** A required field on `submitCompanyInquirySchema` that this apex-only lead
 * form never surfaces as a UI field (it's `support-form.tsx`'s own field) —
 * every submission from this page is tagged with a fixed value instead of
 * asking the visitor to pick one. */
const REQUEST_TYPE = "General inquiry";

function parsePositiveInt(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : NaN;
}

/**
 * IZUR's own apex sales-qualification lead form — posts to
 * `POST /public/company-inquiries` (`apps/chrono-api/src/modules/
 * company-inquiry`) with `source: "contact"`, mirroring `support-form.tsx`'s
 * fetch pattern plus the two extra optional count fields and oikos's
 * per-field inline validation (`~/karta/karta-tenant/.../ContactForm.tsx`'s
 * `!isTenant` branch, structure only — rebuilt from `agora/ui` primitives).
 */
export function ContactForm() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [numberOfPcs, setNumberOfPcs] = useState("");
  const [numberOfBranches, setNumberOfBranches] = useState("");
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function validate(): FieldErrors | null {
    const errors: FieldErrors = {};

    if (!name.trim()) {
      errors.name = "Name is required";
    }

    if (!email.trim()) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = "Invalid email address";
    }

    if (!message.trim()) {
      errors.message = "Message is required";
    } else if (message.length > MESSAGE_MAX_LENGTH) {
      errors.message = `Message cannot exceed ${MESSAGE_MAX_LENGTH} characters`;
    }

    const pcs = parsePositiveInt(numberOfPcs);
    if (Number.isNaN(pcs)) {
      errors.numberOfPcs = "Number of PCs must be a positive number";
    }

    const branches = parsePositiveInt(numberOfBranches);
    if (Number.isNaN(branches)) {
      errors.numberOfBranches = "Number of branches must be a positive number";
    }

    return Object.keys(errors).length > 0 ? errors : null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    const errors = validate();
    if (errors) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    const pcs = parsePositiveInt(numberOfPcs);
    const branches = parsePositiveInt(numberOfBranches);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
    const res = await fetch(`${apiUrl}/public/company-inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        businessName: businessName.trim() || undefined,
        requestType: REQUEST_TYPE,
        message: message.trim(),
        numberOfPcs: pcs && pcs > 0 ? pcs : undefined,
        numberOfBranches: branches && branches > 0 ? branches : undefined,
        source: "contact",
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

  function onReset() {
    setSubmitted(false);
    setName("");
    setEmail("");
    setBusinessName("");
    setNumberOfPcs("");
    setNumberOfBranches("");
    setMessage("");
    setFieldErrors({});
  }

  if (submitted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Message Sent</CardTitle>
          <CardDescription>
            Thank you for reaching out. Our team will get back to you within
            24 hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onReset}>
            Send another message
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a message</CardTitle>
        <CardDescription>
          Tell us about your cafe setup and we&apos;ll follow up with the next
          best step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-name">Name</Label>
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!fieldErrors.name}
                aria-describedby={fieldErrors.name ? "contact-name-error" : undefined}
              />
              {fieldErrors.name && (
                <p id="contact-name-error" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.name}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-email">Email</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!fieldErrors.email}
                aria-describedby={fieldErrors.email ? "contact-email-error" : undefined}
              />
              {fieldErrors.email && (
                <p id="contact-email-error" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.email}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact-business">Cafe / business name</Label>
            <Input
              id="contact-business"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-pcs">Number of PCs</Label>
              <Input
                id="contact-pcs"
                type="number"
                min={1}
                placeholder="50"
                value={numberOfPcs}
                onChange={(e) => setNumberOfPcs(e.target.value)}
                aria-invalid={!!fieldErrors.numberOfPcs}
                aria-describedby={fieldErrors.numberOfPcs ? "contact-pcs-error" : undefined}
              />
              {fieldErrors.numberOfPcs && (
                <p id="contact-pcs-error" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.numberOfPcs}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-branches">Number of branches</Label>
              <Input
                id="contact-branches"
                type="number"
                min={1}
                placeholder="1"
                value={numberOfBranches}
                onChange={(e) => setNumberOfBranches(e.target.value)}
                aria-invalid={!!fieldErrors.numberOfBranches}
                aria-describedby={
                  fieldErrors.numberOfBranches ? "contact-branches-error" : undefined
                }
              />
              {fieldErrors.numberOfBranches && (
                <p id="contact-branches-error" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.numberOfBranches}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact-message">Message</Label>
            <Textarea
              id="contact-message"
              placeholder="Tell us about your operations…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              aria-invalid={!!fieldErrors.message}
              aria-describedby={fieldErrors.message ? "contact-message-error" : undefined}
            />
            <div className="flex items-center justify-between">
              {fieldErrors.message ? (
                <p id="contact-message-error" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.message}
                </p>
              ) : (
                <span />
              )}
              <span className="text-xs text-muted-foreground">
                {message.length}/{MESSAGE_MAX_LENGTH}
              </span>
            </div>
          </div>

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Sending…" : "Send Request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
