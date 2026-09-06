"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  buttonVariants,
  Label,
  Input,
  Textarea,
  Field,
  Stack,
  Row,
  toast,
} from "agora/ui";
import { submitBusinessLead } from "../../../lib/discover-client";

/**
 * "Can't find your gaming café? Bring them to Chrono."
 *
 * Submitting requires a signed-in global customer. When the session is missing
 * the form does NOT navigate away — it stays mounted and shows the sign-in
 * prompt inline, so everything already typed survives. `/portal/login` ignores
 * `?next=` (it hardcodes a redirect to `/portal`), so a redirect round trip
 * would silently discard the café name the player just typed — the exact
 * dead-end this whole surface exists to remove.
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
  const [needsSignIn, setNeedsSignIn] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!businessName.trim()) return;
    setSubmitting(true);
    setNeedsSignIn(false);

    const result = await submitBusinessLead({
      businessName: businessName.trim(),
      city: city.trim() || undefined,
      message: message.trim() || undefined,
    });
    setSubmitting(false);

    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        setNeedsSignIn(true);
        return;
      }
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

            {needsSignIn ? (
              <Card data-testid="discover-invite-signin-prompt">
                <CardHeader>
                  <CardTitle>Sign in to invite a business</CardTitle>
                  <CardDescription>
                    Your Chrono player account lets us tell this business how many
                    people are asking for them. Nothing you typed here is lost —
                    sign in, then submit again.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Row gap={2} wrap>
                    {/* Opened in a new tab so this form — and the café name
                        already typed into it — stays exactly where it is. */}
                    <Link
                      href="/portal/login"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonVariants({ variant: "outline" })}
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/portal/sign-up"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonVariants({ variant: "ghost" })}
                    >
                      Create an account
                    </Link>
                  </Row>
                </CardContent>
              </Card>
            ) : null}

            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending…" : "Invite this café"}
            </Button>
          </Stack>
        </form>
      </CardContent>
    </Card>
  );
}
