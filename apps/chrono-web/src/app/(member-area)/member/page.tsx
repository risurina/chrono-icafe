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
import { formatMinutes, formatCurrency, formatDate } from "@/lib/member/format";
import { getMySessionSummary, type SessionSummary } from "@/lib/member/session";
import { getMyWalletBalance, getLastTopUp, type WalletBalance, type WalletTransaction } from "@/lib/member/wallet";
import { getMyLoyalty, type LoyaltyMe } from "@/lib/member/loyalty";
import { getCreditProducts, type CreditProduct } from "@/lib/member/credits";

function TierBadge({ tier }: { tier: string }) {
  return <Badge className="capitalize">{tier}</Badge>;
}

export default function MemberDashboardPage() {
  const { member, onboarding, approved } = useMemberArea();

  const [session, setSession] = useState<SessionSummary | null>(null);
  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  const [lastTopUp, setLastTopUp] = useState<WalletTransaction | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyMe | null>(null);
  const [products, setProducts] = useState<CreditProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [s, w, t, l, p] = await Promise.all([
      getMySessionSummary(),
      getMyWalletBalance(),
      getLastTopUp(),
      getMyLoyalty(),
      getCreditProducts(),
    ]);
    if (s.data) setSession(s.data);
    if (w.data) setWallet(w.data);
    if (t.data !== undefined) setLastTopUp(t.data);
    if (l.data) setLoyalty(l.data);
    if (p.data) setProducts(p.data);
    setLoading(false);
  }, []);

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
                : "Your application was not approved. Contact the business for help."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* Playtime hero */}
      <Card data-testid="playtime-hero">
        <CardHeader>
          <CardTitle>Playtime</CardTitle>
          <CardDescription>
            {session?.active
              ? `Active on ${session.active.stationName}`
              : "No active session right now."}
          </CardDescription>
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
              <Badge variant={session?.active ? "success" : "secondary"}>
                {session?.active ? "Session active" : "Idle"}
              </Badge>
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
    </Stack>
  );
}

function formatSecondsToday(seconds: number): string {
  return formatMinutes(seconds / 60);
}
