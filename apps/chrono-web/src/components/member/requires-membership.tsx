"use client";

import { Lock } from "lucide-react";
import { Card, CardContent, Row, Stack } from "agora/ui";
import type { MemberUser } from "@/lib/member-client";

/**
 * Guards the interactive/data-bearing part of a `/member/*` page so a guest
 * (a signed-in global customer who hasn't applied to this tenant yet —
 * `member === null`, see `member-area-context.tsx`) never triggers a
 * member-only `/portal/*` call that would 401. Callers gate their own
 * `load()`/`useEffect` on `member` separately — this component only decides
 * what renders, not what fetches.
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
  if (member) return <>{children}</>;
  if (fallback) return <>{fallback}</>;

  return (
    <Card>
      <CardContent className="p-6">
        <Row items="center" gap={3}>
          <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
          <Stack gap={0}>
            <span className="text-sm font-medium">Apply to unlock this section</span>
            <span className="text-xs text-muted-foreground">
              Join this business to see your live account data here.
            </span>
          </Stack>
        </Row>
      </CardContent>
    </Card>
  );
}
