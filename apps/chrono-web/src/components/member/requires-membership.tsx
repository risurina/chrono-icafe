"use client";

import { Lock } from "lucide-react";
import { Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Row, Stack } from "agora/ui";
import type { MemberUser } from "@/lib/member-client";
import { useApplyForTenant } from "./apply-for-tenant-prompt";

/**
 * Guards the interactive/data-bearing part of a `/member/*` page so a guest
 * (a signed-in global customer who hasn't applied to this tenant yet —
 * `member === null`, see `member-area-context.tsx`) never triggers a
 * member-only `/portal/*` call that would 401. Callers gate their own
 * `load()`/`useEffect` on `member` separately — this component only decides
 * what renders, not what fetches.
 *
 * `useApplyForTenant()` is called unconditionally (rules of hooks) even though
 * its state is only ever rendered in the guest (`member === null`) fallback
 * branch below — the top-of-portal "not-applied" banner was removed, so this
 * per-section locked card is now the only place the Apply CTA lives.
 */
export function RequiresMembership({
  member,
  children,
  fallback,
}: {
  member: MemberUser | null;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { applying, apply } = useApplyForTenant();

  if (member) return <>{children}</>;
  if (fallback) return <>{fallback}</>;

  return (
    <Card>
      <CardHeader>
        <Row items="center" gap={3}>
          <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
          <Stack gap={0}>
            <CardTitle>Join this business to see your live account data here.</CardTitle>
            <CardDescription>
              Apply to become a customer of this business to unlock this section.
            </CardDescription>
          </Stack>
        </Row>
      </CardHeader>
      <CardContent>
        <Button onClick={apply} disabled={applying} size="sm">
          {applying ? "Applying…" : "Apply"}
        </Button>
      </CardContent>
    </Card>
  );
}
