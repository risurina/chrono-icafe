"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton, Stack, Row, buttonVariants } from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { formatCurrency, formatDateTime, formatMinutes } from "@/lib/member/format";
import { getMySession, type SessionDetail } from "@/lib/member/session";
import { useLiveRefresh } from "@/lib/member/use-live-refresh";

const STATUS_VARIANT: Record<SessionDetail["status"], "default" | "secondary" | "outline"> = {
  active: "default",
  paused: "secondary",
  ended: "outline",
};

// Poll while this session is still running so elapsed time / status / the
// eventual final charge stay current with no manual refresh — see
// use-live-refresh.ts for why polling over realtime.
const ACTIVE_SESSION_POLL_MS = 12_000;

export default function MemberSessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<SessionDetail | null | undefined>(undefined);

  const load = useCallback(async () => {
    const res = await getMySession(id);
    setSession(res.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stop polling once the session has ended (or wasn't found) — a permanent
  // state, so there is nothing left to go stale.
  const isLive = session?.status === "active" || session?.status === "paused";
  useLiveRefresh(load, ACTIVE_SESSION_POLL_MS, isLive);

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Session detail"
        description="A single session's timeline and charges."
        actions={<RefreshButton onRefresh={load} />}
      />

      {session === undefined ? (
        <Card>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : session === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Session not found</CardTitle>
            <CardDescription>
              This session doesn&apos;t exist or isn&apos;t yours.{" "}
              <Link href="/member/session" className="underline underline-offset-2">
                Back to sessions
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <Row items="center" className="justify-between gap-4">
              <Stack gap={1}>
                <CardTitle>{session.stationName}</CardTitle>
                <CardDescription>Started {formatDateTime(session.startedAt)}</CardDescription>
              </Stack>
              <Badge variant={STATUS_VARIANT[session.status]} className="capitalize">
                {session.status}
              </Badge>
            </Row>
          </CardHeader>
          <CardContent>
            <Stack gap={3}>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Ended</span>
                <span className="font-medium">{session.endedAt ? formatDateTime(session.endedAt) : "—"}</span>
              </Row>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Duration</span>
                <span className="font-medium">
                  {session.actualBillableSeconds != null ? formatMinutes(session.actualBillableSeconds / 60) : "—"}
                </span>
              </Row>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Credit minutes used</span>
                <span className="font-medium">{session.creditMinutesConsumed}</span>
              </Row>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Amount charged</span>
                <span className="font-medium">
                  {session.amountCharged ? formatCurrency(session.amountCharged, session.currency) : "—"}
                </span>
              </Row>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Link href="/member/session" className={cn(buttonVariants({ variant: "outline" }))}>
        Back to sessions
      </Link>
    </Stack>
  );
}
