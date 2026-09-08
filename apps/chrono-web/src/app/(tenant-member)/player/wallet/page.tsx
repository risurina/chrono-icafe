"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  Button,
  Input,
  Label,
  Skeleton,
  DataTable,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Stack,
  Row,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  FormError,
  toast,
} from "agora/ui";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { RefreshButton } from "@/components/member/refresh-button";
import { RequiresMembership } from "@/components/member/requires-membership";
import { useMemberArea } from "@/components/member/member-area-context";
import { formatCurrency, formatDateTime, type PaginationMeta } from "@/lib/member/format";
import { getMyWalletBalance, getMyWalletHistory, type WalletBalance, type WalletTransaction } from "@/lib/member/wallet";
import {
  createCheckout,
  getPayment,
  getPaymentGateway,
  type PaymentGatewayStatus,
  type PortalPayment,
} from "@/lib/member/payments";

const TYPE_VARIANT: Record<WalletTransaction["type"], "default" | "secondary" | "outline"> = {
  credit: "default",
  debit: "secondary",
  adjustment: "outline",
};

// Wallet-top-up amount bounds — mirrors MIN/MAX_WALLET_TOPUP_AMOUNT in
// apps/chrono-api/src/modules/payment/contracts.ts. Kept here as a display
// constant (not imported cross-app) since the server re-validates regardless.
const MIN_TOPUP_AMOUNT = "20.00";
const MAX_TOPUP_AMOUNT = "10000.00";
const PRESET_TOPUP_AMOUNTS = ["50.00", "100.00", "200.00", "500.00"] as const;

// Bounded backoff for the return-from-checkout poll: never poll forever —
// after the last interval the banner stops auto-polling and leaves a manual
// "Check again" action, per the plan's "Fulfilment is webhook-only" rule
// (the page must never claim success itself, only reflect webhook state).
const POLL_INTERVALS_MS = [2000, 3000, 5000, 8000, 13000];

/**
 * Online-checkout return/poll banner for `?payment=<id>` — the successUrl/
 * cancelUrl PayMongo redirects back to (apps/chrono-api/src/modules/payment/
 * portal-routes.ts). `payment=cancelled` is a literal sentinel the backend
 * sends on the PSP's own cancel URL, never a real payment id — it is handled
 * without an API call. This banner NEVER claims success on its own; it only
 * ever reflects what `GET /portal/payments/:id` reports, which only the
 * webhook (`fulfilCustomerPayment`) can flip to "paid".
 */
function PaymentStatusCard({
  paymentId,
  onSettled,
  onDismiss,
}: {
  paymentId: string;
  onSettled: () => void;
  onDismiss: () => void;
}) {
  const [payment, setPayment] = useState<PortalPayment | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const attemptRef = useRef(0);
  const settledRef = useRef(false);

  const poll = useCallback(async () => {
    const res = await getPayment(paymentId);
    if (!res.data) {
      setError(res.error);
      setPayment(null);
      setPolling(false);
      return;
    }
    const data = res.data;
    setPayment(data);
    setError(null);
    if (data.status === "paid" && !settledRef.current) {
      settledRef.current = true;
      onSettled();
    }
    if (data.status !== "pending") {
      setPolling(false);
    }
  }, [paymentId, onSettled]);

  useEffect(() => {
    void poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId]);

  useEffect(() => {
    if (!polling) return;
    const delay = POLL_INTERVALS_MS[attemptRef.current];
    if (delay === undefined) {
      setPolling(false);
      return;
    }
    const timer = setTimeout(() => {
      attemptRef.current += 1;
      void poll();
    }, delay);
    return () => clearTimeout(timer);
  }, [polling, poll, payment]);

  function checkAgain() {
    attemptRef.current = 0;
    setPolling(true);
    void poll();
  }

  let title = "Checking payment…";
  let description: string;
  if (payment === undefined) {
    description = "Looking up your payment.";
  } else if (payment === null) {
    title = "Payment not found";
    description = error ?? "We couldn't find that payment.";
  } else if (payment.status === "paid") {
    title = "Payment successful";
    description =
      payment.purpose === "credit_purchase"
        ? `${formatCurrency(payment.amount, payment.currency)} paid — your credit pack has been added. Check the Promos page for your new balance.`
        : `${formatCurrency(payment.amount, payment.currency)} added to your wallet.`;
  } else if (payment.status === "pending") {
    title = "Payment received";
    description = "Payment received — credits are being added. Refresh in a moment.";
  } else if (payment.status === "voided") {
    title = "Payment not completed";
    description = "This payment could not be completed. No credits were added. Please contact staff if you were charged.";
  } else {
    title = "Payment refunded";
    description = "This payment was refunded.";
  }

  return (
    <Card data-testid="payment-status-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Row gap={2}>
          {!polling && payment?.status === "pending" ? (
            <Button variant="outline" size="sm" onClick={checkAgain}>
              Check again
            </Button>
          ) : null}
          {payment && payment.status !== "pending" ? (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </Row>
      </CardFooter>
    </Card>
  );
}

export default function MemberWalletPage() {
  const { member } = useMemberArea();
  const router = useRouter();
  const searchParams = useSearchParams();
  const paymentParam = searchParams.get("payment");

  const query = useListQuery([]);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [gateway, setGateway] = useState<PaymentGatewayStatus | null>(null);

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [topupError, setTopupError] = useState<string | null>(null);
  const [topupSubmitting, setTopupSubmitting] = useState(false);
  // Re-entry guard (a `useRef`, checked synchronously — unlike `topupSubmitting`
  // state, which only disables the button after the next render) plus a stable
  // idempotency key held across a retry of the SAME attempt. Reset to null
  // only once the dialog is (re)opened, so a failed attempt's retry reuses
  // the key but a genuinely new top-up gets a fresh one. See
  // member-wallet-operation-hardening plan.
  const topupSubmittingRef = useRef(false);
  const topupIdempotencyKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    // Guest mode — every call below is member-only (`memberMiddleware()`)
    // and would 401 with no `tenantMember` row yet.
    if (!member) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [b, h, g] = await Promise.all([
      getMyWalletBalance(),
      getMyWalletHistory({
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort ?? "createdAt",
        order: query.order,
      }),
      getPaymentGateway(),
    ]);
    if (b.data) setBalance(b.data);
    if (h.data) {
      setItems(h.data.items);
      setMeta(h.data.meta);
    }
    if (g.data) setGateway(g.data);
    setLoading(false);
  }, [member, query.page, query.pageSize, query.sort, query.order]);

  useEffect(() => {
    void load();
  }, [load]);

  function dismissPaymentBanner() {
    router.replace("/member/wallet");
  }

  async function onSubmitTopup() {
    if (topupSubmittingRef.current) return;
    setTopupError(null);
    const amount = Number(topupAmount);
    if (!topupAmount || Number.isNaN(amount) || amount < Number(MIN_TOPUP_AMOUNT) || amount > Number(MAX_TOPUP_AMOUNT)) {
      setTopupError(
        `Enter an amount between ${formatCurrency(MIN_TOPUP_AMOUNT, gateway?.currency)} and ${formatCurrency(
          MAX_TOPUP_AMOUNT,
          gateway?.currency,
        )}.`,
      );
      return;
    }
    topupSubmittingRef.current = true;
    if (!topupIdempotencyKeyRef.current) {
      topupIdempotencyKeyRef.current = crypto.randomUUID();
    }
    setTopupSubmitting(true);
    const res = await createCheckout(
      { purpose: "wallet_topup", amount: topupAmount },
      topupIdempotencyKeyRef.current,
    );
    setTopupSubmitting(false);
    topupSubmittingRef.current = false;
    if (!res.data) {
      toast.error(res.error ?? "Unable to start checkout.");
      return;
    }
    // Succeeded — about to navigate away, so the next dialog open (a
    // genuinely new top-up) should mint a fresh key rather than replay this one.
    topupIdempotencyKeyRef.current = null;
    window.location.href = res.data.checkoutUrl;
  }

  const columns: DataTableColumn<WalletTransaction>[] = [
    {
      key: "type",
      header: "Type",
      render: (row) => (
        <Badge variant={TYPE_VARIANT[row.type]} className="capitalize">
          {row.type}
        </Badge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => formatCurrency(row.amount),
    },
    {
      key: "balanceAfter",
      header: "Balance after",
      render: (row) => formatCurrency(row.balanceAfter),
    },
    { key: "reason", header: "Reason", render: (row) => row.reason },
    {
      key: "createdAt",
      header: "Date",
      sortable: true,
      render: (row) => formatDateTime(row.createdAt),
    },
  ];

  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Wallet"
        description="Your wallet balance and transaction history."
        actions={<RefreshButton onRefresh={load} />}
      />

      <RequiresMembership member={member}>
      {paymentParam === "cancelled" ? (
        <Card data-testid="payment-status-card">
          <CardHeader>
            <CardTitle>Checkout cancelled</CardTitle>
            <CardDescription>You cancelled the payment — no charge was made.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="outline" size="sm" onClick={dismissPaymentBanner}>
              Dismiss
            </Button>
          </CardFooter>
        </Card>
      ) : paymentParam ? (
        <PaymentStatusCard
          paymentId={paymentParam}
          onSettled={() => void load()}
          onDismiss={dismissPaymentBanner}
        />
      ) : null}

      <Card data-testid="wallet-balance-card">
        <CardHeader>
          <CardTitle>Balance</CardTitle>
          <CardDescription>Available funds for credit purchases.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !balance ? (
            <Skeleton className="h-10 w-40" />
          ) : (
            <p className="text-3xl font-semibold">{formatCurrency(balance?.balance ?? "0.00", balance?.currency)}</p>
          )}
        </CardContent>
        <CardFooter>
          <Stack gap={2}>
            <Button
              data-testid="topup-button"
              onClick={() => {
                topupIdempotencyKeyRef.current = null;
                setTopupOpen(true);
              }}
              disabled={!gateway?.available}
            >
              Top up online
            </Button>
            {!loading && !gateway?.available ? (
              <p className="text-sm text-muted-foreground">Ask staff at the counter to add credits.</p>
            ) : null}
          </Stack>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transaction history</CardTitle>
        </CardHeader>
        <CardContent>
          <Stack gap={4}>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(row) => row.id}
              loading={loading}
              emptyMessage="No wallet transactions yet."
              sort={query.sort}
              order={query.order}
              onSortChange={query.setSort}
            />
            {meta ? (
              <DataTablePagination meta={meta} onPageChange={query.setPage} onPageSizeChange={query.setPageSize} />
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <Row items="center" gap={2}>
              <DialogTitle>Top up your wallet</DialogTitle>
              <Badge variant="outline">Secured by PayMongo</Badge>
            </Row>
            <DialogDescription>
              Pay online with GCash or a card via PayMongo. You&apos;ll be redirected to a secure PayMongo payment page.
            </DialogDescription>
          </DialogHeader>
          <Stack gap={2}>
            <Row gap={2} wrap>
              {PRESET_TOPUP_AMOUNTS.map((amt) => (
                <Button
                  key={amt}
                  type="button"
                  size="sm"
                  variant={topupAmount === amt ? "default" : "outline"}
                  onClick={() => {
                    setTopupAmount(amt);
                    setTopupError(null);
                  }}
                  data-testid={`topup-preset-${amt}`}
                >
                  {formatCurrency(amt, gateway?.currency)}
                </Button>
              ))}
            </Row>
            <Label htmlFor="topup-amount">Amount ({gateway?.currency ?? "PHP"})</Label>
            <Input
              id="topup-amount"
              type="number"
              min={MIN_TOPUP_AMOUNT}
              max={MAX_TOPUP_AMOUNT}
              step="0.01"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              placeholder={`${MIN_TOPUP_AMOUNT} - ${MAX_TOPUP_AMOUNT}`}
              data-testid="topup-amount-input"
            />
            <FormError message={topupError} />
          </Stack>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopupOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSubmitTopup} disabled={topupSubmitting} data-testid="topup-submit">
              {topupSubmitting ? "Redirecting…" : "Continue to payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </RequiresMembership>
    </Stack>
  );
}
