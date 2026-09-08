"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  Button,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Stack,
  Row,
  buttonVariants,
  toast,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { MemberPageHeader } from "@/components/member/member-page-header";
import { useMemberArea } from "@/components/member/member-area-context";
import { UnlockHint } from "@/components/member/unlock-hint";
import { formatCurrency, formatMinutes } from "@/lib/member/format";
import { getCreditProducts, purchaseCreditProduct, type CreditProduct } from "@/lib/member/credits";
import { getMyWalletBalance, type WalletBalance } from "@/lib/member/wallet";
import { createCheckout, getPaymentGateway, type PaymentGatewayStatus } from "@/lib/member/payments";

export default function MemberPromoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { canInteract } = useMemberArea();
  const [product, setProduct] = useState<CreditProduct | null | undefined>(undefined);
  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  const [gateway, setGateway] = useState<PaymentGatewayStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [buyingOnline, setBuyingOnline] = useState(false);
  // Re-entry guards + stable per-attempt idempotency keys (member-wallet-
  // operation-hardening plan) — see the same pattern's comment on
  // /member/wallet's topup handler for the full reasoning.
  const purchaseSubmittingRef = useRef(false);
  const purchaseIdempotencyKeyRef = useRef<string | null>(null);
  const buyOnlineSubmittingRef = useRef(false);
  const buyOnlineIdempotencyKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [products, balance, gatewayStatus] = await Promise.all([
      getCreditProducts(),
      getMyWalletBalance(),
      getPaymentGateway(),
    ]);
    const found = products.data?.find((p) => p.id === id) ?? null;
    setProduct(found);
    if (balance.data) setWallet(balance.data);
    if (gatewayStatus.data) setGateway(gatewayStatus.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const insufficient = product ? Number(wallet?.balance ?? "0") < Number(product.priceAmount) : false;

  async function onConfirmPurchase() {
    if (!product || purchaseSubmittingRef.current) return;
    purchaseSubmittingRef.current = true;
    if (!purchaseIdempotencyKeyRef.current) {
      purchaseIdempotencyKeyRef.current = crypto.randomUUID();
    }
    setPurchasing(true);
    const res = await purchaseCreditProduct(product.id, purchaseIdempotencyKeyRef.current);
    setPurchasing(false);
    setConfirmOpen(false);
    purchaseSubmittingRef.current = false;
    if (res.error) {
      toast.error(res.error);
      return;
    }
    // Succeeded — a genuinely new purchase attempt later gets a fresh key.
    purchaseIdempotencyKeyRef.current = null;
    const newBalance = await getMyWalletBalance();
    if (newBalance.data) setWallet(newBalance.data);
    toast.success(
      `Purchased ${formatMinutes(product.quantityMinutes)}. New balance: ${formatCurrency(
        newBalance.data?.balance ?? "0.00",
      )}.`,
    );
  }

  // Online PSP checkout (GCash/card) — fulfilment is webhook-only, so this
  // never grants anything itself. It only creates the pending payment +
  // checkout session and redirects; the return page (/member/wallet)
  // polls for the webhook's outcome.
  async function onBuyOnline() {
    if (!product || buyOnlineSubmittingRef.current) return;
    buyOnlineSubmittingRef.current = true;
    if (!buyOnlineIdempotencyKeyRef.current) {
      buyOnlineIdempotencyKeyRef.current = crypto.randomUUID();
    }
    setBuyingOnline(true);
    const res = await createCheckout(
      { purpose: "credit_purchase", productId: product.id },
      buyOnlineIdempotencyKeyRef.current,
    );
    setBuyingOnline(false);
    buyOnlineSubmittingRef.current = false;
    if (!res.data) {
      toast.error(res.error ?? "Unable to start checkout.");
      return;
    }
    buyOnlineIdempotencyKeyRef.current = null;
    window.location.href = res.data.checkoutUrl;
  }

  return (
    <Stack gap={6}>
      <MemberPageHeader title="Credit pack" description="Review and buy this credit pack." />

      {product === undefined ? (
        <Card>
          <CardContent>
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      ) : product === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Pack not found</CardTitle>
            <CardDescription>
              This credit pack isn&apos;t available.{" "}
              <Link href="/member/promos" className="underline underline-offset-2">
                Back to promos
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card data-testid="credit-product-detail">
          <CardHeader>
            <CardTitle>{product.name}</CardTitle>
            <CardDescription>{formatMinutes(product.quantityMinutes)} of playtime</CardDescription>
          </CardHeader>
          <CardContent>
            <Stack gap={3}>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Price</span>
                <span className="text-lg font-semibold">{formatCurrency(product.priceAmount)}</span>
              </Row>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Validity</span>
                <span className="font-medium">
                  {product.validityDays ? `${product.validityDays} days` : "No expiry"}
                </span>
              </Row>
              <Row items="center" className="justify-between">
                <span className="text-sm text-muted-foreground">Your wallet balance</span>
                <span className="font-medium">{formatCurrency(wallet?.balance ?? "0.00")}</span>
              </Row>
              {insufficient ? (
                <Badge variant="secondary" className="w-fit">
                  Insufficient balance — top up your wallet first
                </Badge>
              ) : null}
            </Stack>
          </CardContent>
          <CardFooter>
            <Stack gap={2}>
              <Row gap={2}>
                <Button
                  onClick={() => {
                    purchaseIdempotencyKeyRef.current = null;
                    setConfirmOpen(true);
                  }}
                  disabled={insufficient || !canInteract}
                >
                  Buy with wallet
                </Button>
                <Button
                  variant="outline"
                  onClick={onBuyOnline}
                  disabled={!gateway?.available || buyingOnline || !canInteract}
                  data-testid="buy-online-button"
                >
                  {buyingOnline ? "Redirecting…" : "Buy online (GCash/Card)"}
                </Button>
              </Row>
              {gateway && !gateway.available ? (
                <p className="text-sm text-muted-foreground">Ask staff at the counter to add credits.</p>
              ) : null}
              {!canInteract ? <UnlockHint /> : null}
            </Stack>
          </CardFooter>
        </Card>
      )}

      <Link href="/member/promos" className={cn(buttonVariants({ variant: "outline" }))}>
        Back to promos
      </Link>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm purchase</DialogTitle>
            <DialogDescription>
              {product
                ? `Buy ${formatMinutes(product.quantityMinutes)} for ${formatCurrency(
                    product.priceAmount,
                  )}? This will be debited from your wallet immediately.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onConfirmPurchase} disabled={purchasing}>
              {purchasing ? "Purchasing…" : "Confirm purchase"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
