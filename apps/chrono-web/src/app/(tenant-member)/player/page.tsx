"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  Progress,
  Skeleton,
  Row,
  Stack,
  Grid,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { useMemberArea } from "@/components/member/member-area-context";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { RequiresMembership } from "@/components/member/requires-membership";
import { formatMinutes, formatCurrency, formatDate, formatDateTime } from "@/lib/member/format";
import { getMySessionSummary, type SessionSummary } from "@/lib/member/session";
import { getMyWalletBalance, getLastTopUp, type WalletBalance, type WalletTransaction } from "@/lib/member/wallet";
import { getMyLoyalty, type LoyaltyMe } from "@/lib/member/loyalty";
import { getCreditProducts, type CreditProduct } from "@/lib/member/credits";
import {
  getMyReservation,
  getPublicStations,
  type PortalReservation,
  type PublicBranch,
} from "@/lib/member/reservations";
import { NeedHelpLinks } from "@/components/member/need-help-links";

function TierBadge({ tier }: { tier: string }) {
  return <Badge className="capitalize">{tier}</Badge>;
}

/** Resolves a reservation's station + branch name from the public stations
 * listing (the same data source `member/reservations/page.tsx` uses) — the
 * reservation DTO itself only carries `stationId`. */
function findStationLabel(branches: PublicBranch[], stationId: string): string | null {
  for (const branch of branches) {
    const station = branch.stations.find((s) => s.id === stationId);
    if (station) return `${station.name} · ${branch.name}`;
  }
  return null;
}

function formatReservationWhen(reservation: PortalReservation): string {
  if (reservation.status === "hold") return "Ready now — claim your hold";
  if (reservation.status === "pending") return "Waiting in queue";
  return reservation.startAt ? formatDateTime(reservation.startAt) : "Scheduled";
}

export default function MemberDashboardPage() {
  const { member, onboarding, approved } = useMemberArea();

  const [session, setSession] = useState<SessionSummary | null>(null);
  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  const [lastTopUp, setLastTopUp] = useState<WalletTransaction | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyMe | null>(null);
  const [products, setProducts] = useState<CreditProduct[]>([]);
  const [reservation, setReservation] = useState<PortalReservation | null>(null);
  const [branches, setBranches] = useState<PublicBranch[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // Guest mode (no `tenantMember` row yet) — every call below except the
    // public stations listing would 401, so skip them entirely rather than
    // fire-then-catch.
    if (!member) {
      setLoading(false);
      return;
    }
    const [s, w, t, l, p, r, stationsRes] = await Promise.all([
      getMySessionSummary(),
      getMyWalletBalance(),
      getLastTopUp(),
      getMyLoyalty(),
      getCreditProducts(),
      getMyReservation(),
      getPublicStations(),
    ]);
    if (s.data) setSession(s.data);
    if (w.data) setWallet(w.data);
    if (t.data !== undefined) setLastTopUp(t.data);
    if (l.data) setLoyalty(l.data);
    if (p.data) setProducts(p.data);
    if (r.data) setReservation(r.data.reservation);
    if (stationsRes) setBranches(stationsRes.branches);
    setLoading(false);
  }, [member]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title={`Welcome${member ? `, ${member.name}` : ""}`}
        description="Your playtime, wallet, and membership at a glance."
        actions={<RefreshButton onRefresh={load} />}
      />

      {onboarding && onboarding.applicationStatus !== "approved" ? (
        <Card data-testid="membership-status-card">
          <CardHeader>
            <CardTitle>Membership status</CardTitle>
            <CardDescription>
              {onboarding.applicationStatus === "pending"
                ? "Your application is pending approval."
                : "Your application was not approved."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NeedHelpLinks />
          </CardContent>
        </Card>
      ) : null}

      <RequiresMembership member={member}>
      {/*
        Home dashboard states (member-portal-v2 phase 2). This branches purely
        on data already fetched above (session summary + the member's own
        reservation, via the existing `getMyReservation()` — no new backend
        route, same call `member/reservations/page.tsx` already makes).

        Precedence rule when more than one state could apply: an ACTIVE
        SESSION always wins the hero slot over an upcoming reservation. An
        active session is a live, currently-happening state the member needs
        to monitor/act on right now; an upcoming reservation is a future
        commitment with no immediate action needed. If a member has both, the
        reservation renders as a small secondary note beside the
        active-session hero — never suppressed, just demoted — so the member
        doesn't lose visibility of an upcoming booking just because they're
        mid-session.
      */}
      <Card data-testid="playtime-hero">
        {session?.active ? (
          <>
            <CardHeader>
              <Row items="center" className="justify-between">
                <CardTitle>Active session</CardTitle>
                <Badge variant="success">Live</Badge>
              </Row>
              <CardDescription>{session.active.stationName}</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <Stack gap={1}>
                  <span className="text-3xl font-bold tracking-tight">
                    {formatSecondsToday(session.today.billableSeconds)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Today&apos;s usage so far — started {formatDate(session.active.startedAt)}
                  </span>
                  {reservation ? (
                    <span
                      data-testid="reservation-secondary-note"
                      className="text-xs text-muted-foreground"
                    >
                      Also upcoming: {findStationLabel(branches, reservation.stationId) ?? "a station"} —{" "}
                      {formatReservationWhen(reservation)}.{" "}
                      <Link href="/member/reservations" className="text-primary hover:underline">
                        View reservation
                      </Link>
                    </span>
                  ) : null}
                </Stack>
              )}
            </CardContent>
            <CardFooter className="gap-2">
              <Link href="/member/session" className={cn(buttonVariants(), "flex-1")}>
                View active session
              </Link>
            </CardFooter>
          </>
        ) : reservation ? (
          <>
            <CardHeader>
              <Row items="center" className="justify-between">
                <CardTitle>Upcoming reservation</CardTitle>
                <Badge variant="secondary">
                  {reservation.status === "hold"
                    ? "Ready"
                    : reservation.status === "pending"
                      ? "In queue"
                      : "Scheduled"}
                </Badge>
              </Row>
              <CardDescription>
                {findStationLabel(branches, reservation.stationId) ?? "Station reserved"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <Stack gap={1}>
                  <span className="text-3xl font-bold tracking-tight">
                    {formatReservationWhen(reservation)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {reservation.status === "hold"
                      ? "Your hold is waiting — head to the station to claim it."
                      : "You have an upcoming reservation."}
                  </span>
                </Stack>
              )}
            </CardContent>
            <CardFooter className="gap-2">
              <Link href="/member/reservations" className={cn(buttonVariants(), "flex-1")}>
                View reservation
              </Link>
            </CardFooter>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Playtime</CardTitle>
              <CardDescription>No active session right now.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <Row items="center" className="justify-between gap-4">
                  <Stack gap={1}>
                    <span className="text-3xl font-bold tracking-tight">
                      {session ? formatSecondsToday(session.today.billableSeconds) : "0m"}
                    </span>
                    <span className="text-xs text-muted-foreground">Today&apos;s usage</span>
                  </Stack>
                  <Badge variant="secondary">Idle</Badge>
                </Row>
              )}
            </CardContent>
            <CardFooter className="gap-2">
              <Link href="/member/session" className={cn(buttonVariants({ variant: "outline" }), "flex-1")}>
                View sessions
              </Link>
              <Link href="/member/reservations" className={cn(buttonVariants(), "flex-1")}>
                Reserve a station
              </Link>
            </CardFooter>
          </>
        )}
      </Card>

      <Grid cols={2} gap={4} className="md:grid-cols-2">
        {/* Wallet card */}
        <Card data-testid="wallet-card">
          <CardHeader>
            <CardTitle>Wallet</CardTitle>
            <CardDescription>Your current balance.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-10 w-2/3" />
            ) : approved ? (
              <Stack gap={1}>
                <span className="text-2xl font-bold">
                  {wallet ? formatCurrency(wallet.balance, wallet.currency) : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {lastTopUp
                    ? `Last top-up ${formatCurrency(lastTopUp.amount, wallet?.currency)} on ${formatDate(lastTopUp.createdAt)}`
                    : "No top-ups yet"}
                </span>
              </Stack>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your wallet unlocks once your application is approved.
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Link href="/member/wallet" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
              Details
            </Link>
          </CardFooter>
        </Card>

        {/* Membership card */}
        <Card data-testid="membership-card">
          <CardHeader>
            <Row items="center" className="justify-between">
              <CardTitle>Membership</CardTitle>
              {approved && loyalty ? <TierBadge tier={loyalty.level.tier} /> : null}
            </Row>
            <CardDescription>
              {approved && loyalty?.memberSince ? `Member since ${formatDate(loyalty.memberSince)}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-10 w-full" />
            ) : approved && loyalty ? (
              <Stack gap={2}>
                <Progress value={loyalty.level.progressPercent} />
                <span className="text-xs text-muted-foreground">
                  {loyalty.level.nextTier
                    ? `${loyalty.level.pointsToNext} points to ${loyalty.level.nextTier}`
                    : "Top tier reached"}
                </span>
              </Stack>
            ) : !approved ? (
              <p className="text-sm text-muted-foreground">
                Wallet and rewards unlock once your application is approved.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </Grid>

      {/* Premium store strip — top 3 sellable credit products */}
      <Card data-testid="premium-store">
        <CardHeader>
          <Row items="center" className="justify-between">
            <CardTitle>Premium store</CardTitle>
            <Link href="/member/promos" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </Row>
          <CardDescription>Top up your play minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : products.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credit packs available right now.</p>
          ) : (
            <Grid cols={3} gap={3} className="md:grid-cols-3">
              {products.slice(0, 3).map((product) => (
                <Card key={product.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{product.name}</CardTitle>
                    <CardDescription>{formatMinutes(product.quantityMinutes)}</CardDescription>
                  </CardHeader>
                  <CardFooter>
                    <span className="text-sm font-semibold">
                      {formatCurrency(product.priceAmount)}
                    </span>
                  </CardFooter>
                </Card>
              ))}
            </Grid>
          )}
        </CardContent>
        <CardFooter>
          <Link href="/member/promos" className={cn(buttonVariants(), "w-full")}>
            Go to store
          </Link>
        </CardFooter>
      </Card>
      </RequiresMembership>
    </Stack>
  );
}

function formatSecondsToday(seconds: number): string {
  return formatMinutes(seconds / 60);
}
