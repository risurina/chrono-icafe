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
  Field,
  Stack,
  toast,
} from "agora/ui";
import { submitBusinessLead } from "../../../lib/discover-client";

/**
 * "Can't find your gaming café? Bring them to Chrono."
 *
 * Submission is anonymous — no sign-in required (matching
 * `modules/company-inquiry`'s public form), so there is no redirect round trip
 * to lose what was typed. If a global customer happens to already be signed
 * in, the API captures that identity server-side; the form itself never
 * checks or requires it.
 */
export function InviteBusinessForm({
  initialBusinessName,
  onSubmitted,
}: {
  initialBusinessName: string;
  onSubmitted?: (meta: { hadCity: boolean; hadMessage: boolean }) => void;
}) {
  const [businessName, setBusinessName] = useState(initialBusinessName);
  const [city, setCity] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!businessName.trim()) return;
    setSubmitting(true);

    const result = await submitBusinessLead({
      businessName: businessName.trim(),
      city: city.trim() || undefined,
      message: message.trim() || undefined,
    });
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    onSubmitted?.({ hadCity: city.trim().length > 0, hadMessage: message.trim().length > 0 });
    // Honest copy: nobody is notified in this version. The request is recorded
    // and surfaces to the business as a demand count if and when it joins.
    toast.success("Thanks — we've recorded your request.");
    setCity("");
    setMessage("");
  }

  return (
    <Card data-testid="discover-invite-form">
      <CardHeader>
        <CardTitle>Can&apos;t find your gaming café?</CardTitle>
        <CardDescription>
          Help bring them to Chrono. Tell us which gaming spot you want to see here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <Stack gap={4}>
            <Field>
              <Label htmlFor="invite-business-name">Café / business name</Label>
              <Input
                id="invite-business-name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="invite-city">City (optional)</Label>
              <Input
                id="invite-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="invite-message">Anything else? (optional)</Label>
              <Textarea
                id="invite-message"
                placeholder="Where is it, what makes it good…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>

            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending…" : "Invite this café"}
            </Button>
          </Stack>
        </form>
      </CardContent>
    </Card>
  );
}
