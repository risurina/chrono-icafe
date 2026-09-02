"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Stack,
  AuthLayout,
  toast,
} from "agora/ui";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/rpc";
import { TenantBrandHeader } from "@/components/tenant-brand-header";

type State =
  { kind: "loading" } | { kind: "error"; message: string } | { kind: "success" };

/**
 * Staff invitation acceptance. Runs on the tenant host. Requires a signed-in
 * staff session; if absent, bounces to /login?next=… and returns here. The API
 * validates the token against this tenant + the session's email.
 */
export default function AcceptInvitePage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await run();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "This invitation could not be accepted.";
        toast.error(message);
        setState({ kind: "error", message });
      }
    })();

    async function run() {
      const token = new URLSearchParams(window.location.search).get("token");
      if (!token) {
        toast.error("This link is missing its token.");
        setState({ kind: "error", message: "This link is missing its token." });
        return;
      }

      const session = await authClient.getSession();
      if (!session.data?.user) {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?next=${next}`;
        return;
      }

      const res = await api.api["accept-invite"].$post({ json: { token } });
      if (res.ok) {
        setState({ kind: "success" });
        setTimeout(() => (window.location.href = "/dashboard"), 900);
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const errorMessage =
          typeof body?.error === "string"
            ? body.error
            : body?.error &&
                typeof body.error === "object" &&
                "message" in body.error &&
                typeof (body.error as { message?: unknown }).message === "string"
              ? (body.error as { message: string }).message
              : undefined;
        const finalError = errorMessage ?? "This invitation could not be accepted.";
        toast.error(finalError);
        setState({
          kind: "error",
          message: finalError,
        });
      }
    }
  }, []);

  return (
    <AuthLayout>
      <TenantBrandHeader />
      <Card>
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
          <CardDescription>Joining this business with your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "loading" ? (
            <p className="text-sm text-muted-foreground">Verifying your invitation…</p>
          ) : null}
          {state.kind === "success" ? (
            <p className="text-sm text-muted-foreground">
              You're in — taking you to the dashboard…
            </p>
          ) : null}
          {state.kind === "error" ? (
            <Stack gap={3}>
              <Button
                variant="outline"
                onClick={() => (window.location.href = "/dashboard")}
              >
                Go to dashboard
              </Button>
            </Stack>
          ) : null}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
