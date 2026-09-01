"use client";

import { useEffect, useState } from "react";
import { AuthLayout, CenteredMessage, Card, CardHeader, CardTitle, CardContent, toast } from "agora/ui";
import { useSession } from "@/lib/auth-client";
import { resolveLandingUrl, describeAuthError } from "@/lib/post-auth";

/**
 * Where an OAuth round trip lands. Better Auth has already validated the IdP
 * response and established (or refused) the session by the time we get here —
 * this page only decides where the user goes next, using the same
 * `resolveLandingUrl()` the password form uses.
 *
 * Lives on the apex because the social callback URL must be a single fixed
 * origin registered with each IdP; a per-tenant subdomain could not be.
 */
export default function AuthCallbackPage() {
  const { data: session, isPending } = useSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) {
      const msg = describeAuthError(code);
      toast.error(msg);
      setError(msg);
      return;
    }
    if (isPending) return;
    if (!session) {
      // No session and no error code: the IdP round trip did not complete.
      window.location.href = "/login?error=oauth_failed";
      return;
    }
    let cancelled = false;
    // The tenant host the ?next= belonged to before the apex round trip; it is
    // validated inside resolveLandingUrl, never trusted as given.
    const nextHost = new URLSearchParams(window.location.search).get("nextHost");
    resolveLandingUrl(nextHost).then((url) => {
      if (!cancelled) window.location.href = url;
    });
    return () => {
      cancelled = true;
    };
  }, [isPending, session]);

  if (error) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader>
            <CardTitle>Could not sign you in</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mt-4 text-sm text-muted-foreground">
              <a href="/login" className="text-primary hover:underline">
                Back to sign in
              </a>
            </p>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  return <CenteredMessage>Signing you in…</CenteredMessage>;
}
