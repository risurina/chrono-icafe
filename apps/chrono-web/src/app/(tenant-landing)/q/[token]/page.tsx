"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  buttonVariants,
  Badge,
  toast,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { isTrustedHost, tenantFetch } from "agora/client";
import { useMemberSession } from "@/lib/member-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type QrStationAvailability = {
  status: "available" | "occupied" | "maintenance" | "offline";
  branchAvailable: number;
  branchTotal: number;
};

type QrResolveResult = {
  tenantSlug: string;
  tenantHost: string;
  stationId: string;
  stationName: string;
  branchName: string;
  requiresLogin: boolean;
  hourlyRate: string | null;
  memberRate: string | null;
  availability: QrStationAvailability;
};

const STATUS_LABEL: Record<QrStationAvailability["status"], string> = {
  available: "Available",
  occupied: "In use",
  maintenance: "Maintenance",
  offline: "Offline",
};

// Matches `formatPeso()` in `components/landing/registry.ts` exactly — same
// "₱30" / "₱30.50" convention used everywhere else a rate is shown publicly.
// A `null`/zero rate (no station group, or an unpriced one) renders nothing,
// same as `toRateCards()` dropping a zero-priced group there.
function formatPeso(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `₱${amount}`;
  return `₱${Number.isInteger(n) ? n.toString() : n.toFixed(2)}`;
}

function formatRate(rate: string | null): string | null {
  if (rate === null || Number(rate) <= 0) return null;
  return `${formatPeso(rate)} / hr`;
}

type QrConsumeResult = {
  resolved: boolean;
  sessionStartAvailable: boolean;
};

type PageState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "redirecting" }
  | { kind: "ready"; station: QrResolveResult }
  | { kind: "consumed" };

/**
 * Public QR scan-landing page — no session, no tenant middleware. The token
 * alone carries which tenant/station it belongs to (qr plan Phase 3), so this
 * page can be reached from any host and must re-anchor itself on the token's
 * own tenant host before doing anything session-related — otherwise a token
 * scanned while accidentally on a different tenant's host would check that
 * OTHER tenant's member session, not the one the token actually belongs to.
 */
export default function QrScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [consuming, setConsuming] = useState(false);
  const { member, isPending } = useMemberSession();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`${API_URL}/public/qr/resolve?token=${encodeURIComponent(token)}`, {
        method: "GET",
      });
      if (cancelled) return;
      if (!res.ok) {
        setState({ kind: "invalid" });
        return;
      }
      const station = (await res.json()) as QrResolveResult;

      const currentHost = window.location.host;
      if (currentHost !== station.tenantHost) {
        if (!isTrustedHost(station.tenantHost)) {
          // Never redirect to a host we can't validate as ours.
          setState({ kind: "invalid" });
          return;
        }
        setState({ kind: "redirecting" });
        window.location.href = `${window.location.protocol}//${station.tenantHost}/q/${token}`;
        return;
      }

      setState({ kind: "ready", station });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (state.kind !== "ready" || isPending) return;
    if (!member) {
      window.location.href = `/login?next=${encodeURIComponent(`/q/${token}`)}`;
    }
  }, [state, isPending, member, token]);

  async function onStart() {
    setConsuming(true);
    const res = await tenantFetch()(`${API_URL}/public/qr/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setConsuming(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null as { error?: string } | null);
      // Business-rule failures (station occupied, insufficient balance, no
      // pricing group) carry their own real message from the server; only
      // a verification failure (tampered/expired token) uses the generic
      // fallback — see the qr module's public-routes.ts consume handler.
      toast.error(body?.error ?? "Invalid or expired code.");
      return;
    }
    await res.json().catch(() => null satisfies QrConsumeResult | null);
    setState({ kind: "consumed" });
  }

  if (state.kind === "loading" || state.kind === "redirecting" || isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (state.kind === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Invalid code</CardTitle>
            <CardDescription>
              This QR code is invalid or has expired. Ask staff to show you a fresh one.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (state.kind === "consumed") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Session started</CardTitle>
            <CardDescription>
              You&apos;re all set — your session is running. Enjoy!
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/member/session" className={cn(buttonVariants(), "w-full")}>
              Go to my session
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!member) {
    // A redirect to /login (member sign-in) is in flight (see effect above).
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>
      </div>
    );
  }

  const { station } = state;
  const rate = formatRate(station.hourlyRate);
  const memberRate = formatRate(station.memberRate);
  const statusVariant =
    station.availability.status === "available"
      ? "default"
      : station.availability.status === "occupied"
        ? "secondary"
        : station.availability.status === "maintenance"
          ? "outline"
          : "destructive";
  const canStart = station.availability.status === "available";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>{station.stationName}</CardTitle>
          <CardDescription>{station.branchName}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Badge variant={statusVariant}>{STATUS_LABEL[station.availability.status]}</Badge>
            <span className="text-sm text-muted-foreground">
              {station.availability.branchAvailable} of {station.availability.branchTotal} available
            </span>
          </div>
          {rate && (
            <div className="text-sm">
              <span className="font-medium">{rate}</span>
              {memberRate && (
                <span className="text-muted-foreground"> · Members {memberRate}</span>
              )}
            </div>
          )}
          <Button className="w-full" disabled={consuming || !canStart} onClick={onStart}>
            {consuming ? "Confirming…" : canStart ? "Start" : "Unavailable"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
