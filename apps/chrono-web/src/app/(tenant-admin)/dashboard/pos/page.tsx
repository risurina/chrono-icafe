"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Button,
  Input,
  Label,
  Stack,
  Row,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "agora/ui";
import { createId } from "agora";
import { api } from "@/lib/rpc";

type Branch = { id: string; name: string; status: "active" | "disabled" };

type Product = {
  id: string;
  name: string;
  sku: string;
  category: string;
  price: string;
  status: "active" | "disabled";
  trackStock: boolean;
  stockQuantity: number;
};

type MemberOption = { memberId: string; name: string; email: string };

type CartLine = {
  key: string;
  productId: string | null;
  name: string;
  unitPrice: string;
  quantity: number;
};

type TenderMethod = "cash" | "card" | "wallet";
type Tender = { method: TenderMethod; amount: string; referenceNumber?: string };

type Receipt = {
  sale: { id: string; totalAmount: string; amountTendered: string; changeAmount: string; createdAt: string };
  items: { id: string; name: string; quantity: number; lineTotal: string }[];
  payments: { id: string; method: TenderMethod; amount: string }[];
  receiptNumber: string;
};

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function money(n: number): string {
  return n.toFixed(2);
}

export default function PosCheckoutPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");

  const [isWalkIn, setIsWalkIn] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberOption[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberOption | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [miscName, setMiscName] = useState("");
  const [miscPrice, setMiscPrice] = useState("");

  const [tenders, setTenders] = useState<Tender[]>([{ method: "cash", amount: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => createId());

  useEffect(() => {
    (async () => {
      const res = await api.rpc.branches.$get({
        query: { page: "1", pageSize: "100", sort: "name", order: "asc" },
      });
      if (res.ok) {
        const body = await res.json();
        const active = (body.items as Branch[]).filter((b) => b.status === "active");
        setBranches(active);
        if (active[0]) setBranchId(active[0].id);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.pos.products.$get({
        query: {
          page: "1",
          pageSize: "100",
          q: productSearch || undefined,
          status: "active",
        },
      });
      if (res.ok) {
        const body = await res.json();
        setProducts(body.items as Product[]);
      }
    })();
  }, [productSearch]);

  useEffect(() => {
    if (!memberSearch.trim()) {
      setMemberResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await api.rpc["member-profiles"].$get({
        query: { page: "1", pageSize: "5", q: memberSearch },
      });
      if (res.ok) {
        const body = await res.json();
        setMemberResults(
          (body.items as { memberId: string; name: string; email: string }[]).map((m) => ({
            memberId: m.memberId,
            name: m.name,
            email: m.email,
          })),
        );
      }
    }, 300);
    return () => clearTimeout(t);
  }, [memberSearch]);

  function addProductToCart(p: Product) {
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        return prev.map((l) =>
          l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...prev,
        { key: createId(), productId: p.id, name: p.name, unitPrice: p.price, quantity: 1 },
      ];
    });
  }

  function addMiscLine() {
    if (!miscName.trim() || !miscPrice.trim()) return;
    setCart((prev) => [
      ...prev,
      {
        key: createId(),
        productId: null,
        name: miscName.trim(),
        unitPrice: miscPrice.trim(),
        quantity: 1,
      },
    ]);
    setMiscName("");
    setMiscPrice("");
  }

  function updateQuantity(key: string, quantity: number) {
    if (quantity <= 0) {
      setCart((prev) => prev.filter((l) => l.key !== key));
      return;
    }
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  const subtotal = useMemo(
    () => cart.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0),
    [cart],
  );

  const tenderedTotal = useMemo(
    () => tenders.reduce((sum, t) => sum + (Number(t.amount) || 0), 0),
    [tenders],
  );

  const changeDue = Math.max(0, tenderedTotal - subtotal);
  const canComplete = branchId && cart.length > 0 && tenderedTotal >= subtotal && !submitting;

  function addTender() {
    setTenders((prev) => [...prev, { method: "cash", amount: "" }]);
  }

  function updateTender(index: number, patch: Partial<Tender>) {
    setTenders((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function removeTender(index: number) {
    setTenders((prev) => prev.filter((_, i) => i !== index));
  }

  function resetSale() {
    setCart([]);
    setTenders([{ method: "cash", amount: "" }]);
    setSelectedMember(null);
    setMemberSearch("");
    setCustomerName("");
    setIsWalkIn(true);
    setIdempotencyKey(createId());
  }

  async function completeSale() {
    if (!canComplete) return;
    setSubmitting(true);
    const res = await api.rpc.pos.sales.$post({
      json: {
        branchId,
        memberId: isWalkIn ? undefined : selectedMember?.memberId,
        customerName: isWalkIn ? customerName.trim() || undefined : undefined,
        idempotencyKey,
        items: cart.map((l) =>
          l.productId
            ? { productId: l.productId, quantity: l.quantity }
            : { name: l.name, unitPrice: l.unitPrice, quantity: l.quantity },
        ),
        payments: tenders
          .filter((t) => Number(t.amount) > 0)
          .map((t) => ({
            method: t.method,
            amount: t.amount,
            referenceNumber: t.referenceNumber || undefined,
          })),
      },
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not complete sale."));
      return;
    }
    const body = (await res.json()) as Receipt;
    setReceipt(body);
    toast.success("Sale completed.");
    resetSale();
  }

  return (
    <Stack gap={8}>
      <Row items="center" justify="between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">POS</h1>
          <p className="text-sm text-muted-foreground">Ring up a sale.</p>
        </div>
        <Row gap={2}>
          <Link href="/admin/pos/products">
            <Button variant="outline">Products</Button>
          </Link>
          <Link href="/admin/pos/history">
            <Button variant="outline">Sale history</Button>
          </Link>
        </Row>
      </Row>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Branch &amp; customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="branch">Branch</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger id="branch">
                    <SelectValue placeholder="Select a branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Row items="center" gap={2}>
                <Button
                  type="button"
                  variant={isWalkIn ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsWalkIn(true)}
                >
                  Walk-in
                </Button>
                <Button
                  type="button"
                  variant={!isWalkIn ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsWalkIn(false)}
                >
                  Member
                </Button>
              </Row>

              {isWalkIn ? (
                <div className="space-y-2">
                  <Label htmlFor="customerName">Customer name (optional)</Label>
                  <Input
                    id="customerName"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="memberSearch">Search member</Label>
                  {selectedMember ? (
                    <Row items="center" justify="between">
                      <span className="text-sm">
                        {selectedMember.name} ({selectedMember.email})
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedMember(null)}>
                        Change
                      </Button>
                    </Row>
                  ) : (
                    <>
                      <Input
                        id="memberSearch"
                        placeholder="Name or email…"
                        value={memberSearch}
                        onChange={(e) => setMemberSearch(e.target.value)}
                      />
                      {memberResults.length > 0 ? (
                        <ul className="divide-y divide-border rounded-md border">
                          {memberResults.map((m) => (
                            <li key={m.memberId}>
                              <button
                                type="button"
                                className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                                onClick={() => {
                                  setSelectedMember(m);
                                  setMemberResults([]);
                                }}
                              >
                                {m.name} ({m.email})
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Products</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                placeholder="Search products…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {products.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addProductToCart(p)}
                    disabled={p.trackStock && p.stockQuantity <= 0}
                    className="rounded-md border p-3 text-left text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">₱{p.price}</p>
                    {p.trackStock ? (
                      <p className="text-xs text-muted-foreground">Stock: {p.stockQuantity}</p>
                    ) : null}
                  </button>
                ))}
                {products.length === 0 ? (
                  <p className="col-span-full text-sm text-muted-foreground">No products found.</p>
                ) : null}
              </div>

              <Row items="end" gap={2}>
                <div className="flex-1 space-y-2">
                  <Label htmlFor="miscName">Misc item</Label>
                  <Input
                    id="miscName"
                    placeholder="Item name"
                    value={miscName}
                    onChange={(e) => setMiscName(e.target.value)}
                  />
                </div>
                <div className="w-28 space-y-2">
                  <Label htmlFor="miscPrice">Price</Label>
                  <Input
                    id="miscPrice"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={miscPrice}
                    onChange={(e) => setMiscPrice(e.target.value)}
                  />
                </div>
                <Button type="button" variant="outline" onClick={addMiscLine}>
                  Add
                </Button>
              </Row>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Cart</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {cart.length === 0 ? (
                <p className="text-sm text-muted-foreground">Cart is empty.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {cart.map((l) => (
                    <li key={l.key} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{l.name}</p>
                        <p className="text-xs text-muted-foreground">₱{l.unitPrice} each</p>
                      </div>
                      <Row items="center" gap={1}>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => updateQuantity(l.key, l.quantity - 1)}
                        >
                          −
                        </Button>
                        <span className="w-6 text-center">{l.quantity}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => updateQuantity(l.key, l.quantity + 1)}
                        >
                          +
                        </Button>
                      </Row>
                      <span className="w-16 shrink-0 text-right font-medium">
                        ₱{money(Number(l.unitPrice) * l.quantity)}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => removeLine(l.key)}>
                        ✕
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-between border-t pt-3 font-medium">
                <span>Subtotal</span>
                <span>₱{money(subtotal)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {tenders.map((t, i) => (
                <Row key={i} items="end" gap={2}>
                  <div className="w-28 space-y-2">
                    <Label>Method</Label>
                    <Select
                      value={t.method}
                      onValueChange={(v) => updateTender(i, { method: v as TenderMethod })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="card">Card</SelectItem>
                        <SelectItem value="wallet">Wallet</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1 space-y-2">
                    <Label>Amount</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={t.amount}
                      onChange={(e) => updateTender(i, { amount: e.target.value })}
                    />
                  </div>
                  {tenders.length > 1 ? (
                    <Button variant="ghost" size="sm" onClick={() => removeTender(i)}>
                      ✕
                    </Button>
                  ) : null}
                </Row>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addTender}>
                Add tender
              </Button>

              <div className="space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between">
                  <span>Tendered</span>
                  <span>₱{money(tenderedTotal)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Change due</span>
                  <span>₱{money(changeDue)}</span>
                </div>
              </div>

              <Button className="w-full" disabled={!canComplete} onClick={completeSale}>
                {submitting ? "Completing…" : "Complete Sale"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!receipt} onOpenChange={(open) => !open && setReceipt(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Receipt #{receipt?.receiptNumber}</DialogTitle>
          </DialogHeader>
          {receipt ? (
            <Stack gap={4}>
              <ul className="divide-y divide-border text-sm">
                {receipt.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between py-2">
                    <span>
                      {item.quantity}× {item.name}
                    </span>
                    <span>₱{item.lineTotal}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-1 text-sm">
                {receipt.payments.map((p) => (
                  <div key={p.id} className="flex justify-between capitalize">
                    <span>{p.method}</span>
                    <span>₱{p.amount}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>₱{receipt.sale.totalAmount}</span>
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Change</span>
                <span>₱{receipt.sale.changeAmount}</span>
              </div>
              <Button variant="outline" onClick={() => window.print()}>
                Print
              </Button>
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
