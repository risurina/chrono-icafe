"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
} from "agora/ui";
import { useMemberSession } from "@/lib/member-client";
import {
  getMyMembership,
  applyForMembership,
  type MemberProfile,
} from "@/lib/member-application";
import {
  getMyWalletBalance,
  getMyWalletHistory,
  type WalletBalance,
  type WalletTransaction,
} from "@/lib/wallet-portal";
import {
  getMyActiveSession,
  type PortalSession,
} from "@/lib/session-portal";
import {
  getMyCreditBalance,
  getMyCreditLedger,
  type CreditActiveLot,
  type CreditLedgerEntry,
} from "@/lib/credits-portal";

/** Customer member area. Placeholder — extend with your customer-facing features. */
export default function PortalHome() {
  const { member } = useMemberSession();

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  const [walletHistory, setWalletHistory] = useState<WalletTransaction[]>([]);
  const [walletLoading, setWalletLoading] = useState(true);

  const [activeSession, setActiveSession] = useState<PortalSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [creditsActiveLots, setCreditsActiveLots] = useState<CreditActiveLot[]>([]);
  const [creditsLedger, setCreditsLedger] = useState<CreditLedgerEntry[]>([]);
  const [creditsLoading, setCreditsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getMyMembership().then(({ data }) => {
      if (!mounted) return;
      if (data) setProfile(data);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    getMyActiveSession().then(({ data }) => {
      if (!mounted) return;
      if (data) setActiveSession(data);
      setSessionLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      getMyWalletBalance(),
      getMyWalletHistory({ page: 1, pageSize: 10 }),
      getMyCreditBalance(),
      getMyCreditLedger({ page: 1, pageSize: 10 }),
    ]).then(
      ([balance, history, creditsBalance, creditsHistory]) => {
        if (!mounted) return;
        if (balance) setWallet(balance);
        if (history) setWalletHistory(history.items);
        setWalletLoading(false);

        if (creditsBalance) setCreditsActiveLots(creditsBalance.activeLots);
        if (creditsHistory) setCreditsLedger(creditsHistory.items);
        setCreditsLoading(false);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  async function onApply() {
    setApplying(true);
    setApplyError(null);
    const { data, error } = await applyForMembership();
    if (error) {
      setApplyError(error);
      setApplying(false);
    } else {
      setProfile(data);
      setApplying(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{member ? `, ${member.name}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          You&apos;re signed in as a customer of this workspace.
        </p>
      </div>

      {sessionLoading ? null : activeSession ? (
        <Card>
          <CardHeader>
            <CardTitle>Current session</CardTitle>
            <CardDescription>Your active station session.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
              <dt className="text-muted-foreground">Station</dt>
              <dd>{activeSession.stationName}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge
                  variant={activeSession.status === "active" ? "success" : "warning"}
                  className="capitalize"
                >
                  {activeSession.status}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Started at</dt>
              <dd>{new Date(activeSession.startedAt).toLocaleString()}</dd>
              {activeSession.scheduledEndAt ? (
                <>
                  <dt className="text-muted-foreground">Scheduled end</dt>
                  <dd>{new Date(activeSession.scheduledEndAt).toLocaleString()}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>Customer profile for this tenant.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{member?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{member?.email ?? "—"}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Membership</CardTitle>
          <CardDescription>Your venue membership status.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : profile ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 items-center">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge
                  variant={
                    profile.applicationStatus === "approved"
                      ? "success"
                      : profile.applicationStatus === "rejected"
                        ? "destructive"
                        : "warning"
                  }
                  className="capitalize"
                >
                  {profile.applicationStatus}
                </Badge>
              </dd>
              {profile.phone ? (
                <>
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd>{profile.phone}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <div className="space-y-4">
              <p>You haven&apos;t applied for membership yet.</p>
              <Button onClick={onApply} disabled={applying}>
                {applying ? "Applying…" : "Apply for membership"}
              </Button>
              {applyError ? (
                <p className="text-sm text-destructive">{applyError}</p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Wallet</CardTitle>
          <CardDescription>Your stored-value balance at this venue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {walletLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <p className="text-2xl font-semibold tracking-tight">
                {wallet?.currency ?? "PHP"} {wallet?.balance ?? "0.00"}
              </p>
              {walletHistory.length === 0 ? (
                <p className="text-muted-foreground">No transactions yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {walletHistory.map((tx) => (
                    <li key={tx.id} className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="truncate capitalize">{tx.type}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {tx.reason} · {new Date(tx.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span className="shrink-0 font-medium">{tx.amount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credits</CardTitle>
          <CardDescription>Your active time lots and recent activity.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          {creditsLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="space-y-3">
                <h3 className="font-medium text-muted-foreground">Active Lots</h3>
                {creditsActiveLots.length === 0 ? (
                  <p>No active lots.</p>
                ) : (
                  <ul className="grid grid-cols-1 gap-3">
                    {creditsActiveLots.map(lot => (
                      <li key={lot.id} className="p-3 border rounded-lg flex justify-between items-center">
                        <div>
                          <p className="font-medium">{lot.remainingQuantity} minutes remaining</p>
                          {lot.expiresAt && <p className="text-xs text-muted-foreground">Expires: {new Date(lot.expiresAt).toLocaleDateString()}</p>}
                        </div>
                        {lot.stationGroupId && <Badge variant="secondary">Group {lot.stationGroupId}</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-3">
                <h3 className="font-medium text-muted-foreground">Recent Ledger</h3>
                {creditsLedger.length === 0 ? (
                  <p>No transactions yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {creditsLedger.map((tx) => (
                      <li key={tx.id} className="flex items-center justify-between gap-4 py-2">
                        <div className="min-w-0">
                          <p className="truncate capitalize">{tx.type}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {tx.reason} · {new Date(tx.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <span className="shrink-0 font-medium">
                          {tx.quantityDelta > 0 ? `+${tx.quantityDelta}` : tx.quantityDelta} min
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
