"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Field,
  Row,
  AuthLayout,
  toast,
} from "agora/ui";
import { slugSchema } from "agora";
import { authClient, useSession } from "@/lib/auth-client";

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // Drop apostrophes rather than turning them into separators, so a
    // possessive name ("rony 03's workspace") slugs to `rony-03s-workspace`
    // and not `rony-03-s-workspace`.
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Create an additional workspace for an already-authenticated user. */
export default function NewWorkspacePage() {
  const { data: session, isPending } = useSession();

  const [workspace, setWorkspace] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    setWelcome(new URLSearchParams(window.location.search).get("welcome") === "1");
  }, []);

  // A user arriving here straight from a social sign-in has typed nothing yet;
  // seed the workspace name from their profile so the common case is one click.
  useEffect(() => {
    const name = session?.user?.name;
    if (!workspaceTouched && name) setWorkspace(`${name}'s workspace`);
  }, [session?.user?.name, workspaceTouched]);

  const effectiveSlug = slugTouched ? slug : slugify(workspace);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    const parsed = slugSchema.safeParse(effectiveSlug);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid workspace URL");
      return;
    }
    setLoading(true);

    const org = await authClient.organization.create({
      name: workspace,
      slug: parsed.data,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (org.error) {
      toast.error(org.error.message ?? "Could not create workspace");
      setLoading(false);
      return;
    }

    const proto = location.protocol;
    location.href = `${proto}//${parsed.data}.${APP_DOMAIN}/dashboard`;
  }

  if (isPending) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader>
            <CardTitle>&nbsp;</CardTitle>
          </CardHeader>
        </Card>
      </AuthLayout>
    );
  }

  if (!session) {
    if (typeof window !== "undefined") {
      location.href = `${location.protocol}//${APP_DOMAIN}/sign-up`;
    }
    return null;
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>
            {welcome ? "Welcome — create your workspace" : "Create a new workspace"}
          </CardTitle>
          <CardDescription>
            {welcome
              ? "Your account is ready. Name your workspace to finish setting up."
              : "You'll be the owner of this new tenant."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="workspace">Workspace name</Label>
              <Input
                id="workspace"
                required
                value={workspace}
                onChange={(e) => {
                  setWorkspaceTouched(true);
                  setWorkspace(e.target.value);
                }}
              />
            </Field>
            <Field>
              <Label htmlFor="slug">Workspace URL</Label>
              <Row items="center" gap={1}>
                <Input
                  id="slug"
                  value={effectiveSlug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(slugify(e.target.value));
                  }}
                />
                <span className="whitespace-nowrap text-sm text-muted-foreground">
                  .{APP_DOMAIN}
                </span>
              </Row>
            </Field>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating…" : "Create workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
