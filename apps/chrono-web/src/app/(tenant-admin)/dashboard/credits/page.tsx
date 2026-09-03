"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Stack,
  Row,
  Button,
  DataTable,
  DataTableToolbar,
  DataTablePagination,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
  Label,
  Textarea,
  Badge,
  useListQuery,
  toast,
  Can,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? fallback;
}

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

type CreditProductRow = {
  id: string;
  name: string;
  code: string;
  quantityMinutes: number;
  priceAmount: string;
  stationGroupId: string | null;
  creditPolicy: "strict_group_only" | "any_station";
  validityDays: number | null;
  status: "draft" | "active" | "archived";
  createdAt: string;
};

type CreditGrantRow = {
  id: string;
  originalQuantity: number;
  remainingQuantity: number;
  stationGroupId: string | null;
  creditPolicy: "strict_group_only" | "any_station";
  status: "granted" | "depleted" | "expired" | "voided";
  expiresAt: string | null;
  createdAt: string;
};

type CreditLedgerEntry = {
  id: string;
  type: string;
  quantityDelta: number;
  quantityAfter: number;
  reason: string | null;
  performedByUserId: string | null;
  createdAt: string;
};

type MemberProfileRow = {
  id: string;
  name: string | null;
  email: string | null;
};

export default function CreditsPage() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  const [activeTab, setActiveTab] = useState("members");

  // --- Members Tab ---
  const memberQuery = useListQuery();
  const [members, setMembers] = useState<MemberProfileRow[]>([]);
  const [memberMeta, setMemberMeta] = useState<PaginationMeta | null>(null);

  const loadMembers = useCallback(async () => {
    const res = await api.rpc.members.$get({
      query: {
        page: String(memberQuery.page),
        pageSize: String(memberQuery.pageSize),
        q: memberQuery.q,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setMembers(body.items as MemberProfileRow[]);
      setMemberMeta(body.meta as PaginationMeta);
    }
  }, [memberQuery.page, memberQuery.pageSize, memberQuery.q]);

  useEffect(() => {
    if (activeTab === "members") {
      loadMembers();
    }
  }, [activeTab, loadMembers]);

  // Selected Member Detail
  const [selectedMember, setSelectedMember] = useState<MemberProfileRow | null>(null);
  const [activeLots, setActiveLots] = useState<CreditGrantRow[]>([]);
  const [totalRemainingMinutes, setTotalRemainingMinutes] = useState(0);

  const loadMemberSummary = useCallback(async (memberId: string) => {
    const res = await api.rpc.credits.members[":memberId"].summary.$get({
      param: { memberId },
    });
    if (res.ok) {
      const body = await res.json();
      setActiveLots(body.grants as CreditGrantRow[]);
      setTotalRemainingMinutes(body.totalRemainingMinutes);
    }
  }, []);

  useEffect(() => {
    if (selectedMember) {
      loadMemberSummary(selectedMember.id);
      loadLedger(selectedMember.id);
    }
  }, [selectedMember, loadMemberSummary]);

  // Ledger for Selected Member
  const ledgerQuery = useListQuery();
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [ledgerMeta, setLedgerMeta] = useState<PaginationMeta | null>(null);

  const loadLedger = useCallback(async (memberId: string) => {
    const res = await api.rpc.credits.members[":memberId"].ledger.$get({
      param: { memberId },
      query: {
        page: String(ledgerQuery.page),
        pageSize: String(ledgerQuery.pageSize),
      },
    });
    if (res.ok) {
      const body = await res.json();
      setLedger(body.items as CreditLedgerEntry[]);
      setLedgerMeta(body.meta as PaginationMeta);
    }
  }, [ledgerQuery.page, ledgerQuery.pageSize]);

  useEffect(() => {
    if (selectedMember) {
      loadLedger(selectedMember.id);
    }
  }, [ledgerQuery.page, ledgerQuery.pageSize, selectedMember, loadLedger]);

  // Sell/Grant/Consume Dialogs
  const [actionDialog, setActionDialog] = useState<{
    type: "sell" | "grant" | "consume";
  } | null>(null);

  // Products for Sell
  const [activeProducts, setActiveProducts] = useState<CreditProductRow[]>([]);
  const [sellProductId, setSellProductId] = useState("");

  // Groups for Grant/Consume/Product
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    (async () => {
      const [pRes, gRes] = await Promise.all([
        api.rpc.credits.products.$get({ query: { status: "active", pageSize: "100" } }),
        api.rpc.stations.groups.$get({ query: { pageSize: "100" } })
      ]);
      if (pRes.ok) {
        const body = await pRes.json();
        setActiveProducts(body.items as CreditProductRow[]);
      }
      if (gRes.ok) {
        const body = await gRes.json();
        setGroups(body.items as { id: string; name: string }[]);
      }
    })();
  }, []);

  const [quantityMinutes, setQuantityMinutes] = useState("");
  const [stationGroupId, setStationGroupId] = useState("any");
  const [creditPolicy, setCreditPolicy] = useState<"strict_group_only" | "any_station">("any_station");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [savingAction, setSavingAction] = useState(false);

  function openActionDialog(type: "sell" | "grant" | "consume") {
    setActionDialog({ type });
    setSellProductId("");
    setQuantityMinutes("");
    setStationGroupId("any");
    setCreditPolicy("any_station");
    setExpiresAt("");
    setReason("");
  }

  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!actionDialog || !selectedMember) return;
    setSavingAction(true);
    try {
      const { type } = actionDialog;
      let res;
      if (type === "sell") {
        res = await api.rpc.credits.members[":memberId"].purchase.$post({
          param: { memberId: selectedMember.id },
          json: { productId: sellProductId },
        });
      } else if (type === "grant") {
        res = await api.rpc.credits.members[":memberId"].grant.$post({
          param: { memberId: selectedMember.id },
          json: {
            quantityMinutes: parseInt(quantityMinutes, 10),
            stationGroupId: stationGroupId === "any" ? undefined : stationGroupId,
            creditPolicy,
            expiresAt: expiresAt || undefined,
            reason,
          },
        });
      } else if (type === "consume") {
        res = await api.rpc.credits.members[":memberId"].consume.$post({
          param: { memberId: selectedMember.id },
          json: {
            quantityMinutes: parseInt(quantityMinutes, 10),
            stationGroupId: stationGroupId === "any" ? undefined : stationGroupId,
            reason,
          },
        });
      }

      if (res && res.ok) {
        toast.success(
          type === "sell"
            ? "Credit product sold."
            : type === "grant"
              ? "Credits granted."
              : "Credits consumed.",
        );
        setActionDialog(null);
        loadMemberSummary(selectedMember.id);
        loadLedger(selectedMember.id);
      } else if (res) {
        const message = await extractError(
          res as Response,
          type === "sell"
            ? "Could not sell credit product."
            : type === "grant"
              ? "Could not grant credits."
              : "Could not consume credits.",
        );
        toast.error(message);
      }
    } finally {
      setSavingAction(false);
    }
  }


  // --- Products Tab ---
  const productQuery = useListQuery();
  const [products, setProducts] = useState<CreditProductRow[]>([]);
  const [productMeta, setProductMeta] = useState<PaginationMeta | null>(null);

  const loadProducts = useCallback(async () => {
    const res = await api.rpc.credits.products.$get({
      query: {
        page: String(productQuery.page),
        pageSize: String(productQuery.pageSize),
        sort: productQuery.sort,
        order: productQuery.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setProducts(body.items as CreditProductRow[]);
      setProductMeta(body.meta as PaginationMeta);
    }
  }, [productQuery.page, productQuery.pageSize, productQuery.sort, productQuery.order]);

  useEffect(() => {
    if (activeTab === "products") {
      loadProducts();
    }
  }, [activeTab, loadProducts]);

  const [productDialog, setProductDialog] = useState<{
    mode: "create" | "edit";
    product?: CreditProductRow;
  } | null>(null);

  const [productName, setProductName] = useState("");
  const [productCode, setProductCode] = useState("");
  const [productQuantity, setProductQuantity] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productGroupId, setProductGroupId] = useState("any");
  const [productPolicy, setProductPolicy] = useState<"strict_group_only" | "any_station">("any_station");
  const [productValidity, setProductValidity] = useState("");
  const [productStatus, setProductStatus] = useState<"draft" | "active" | "archived">("draft");
  const [savingProduct, setSavingProduct] = useState(false);

  function openProductDialog(mode: "create" | "edit", product?: CreditProductRow) {
    setProductDialog({ mode, product });
    if (mode === "edit" && product) {
      setProductName(product.name);
      setProductCode(product.code);
      setProductQuantity(String(product.quantityMinutes));
      setProductPrice(product.priceAmount);
      setProductGroupId(product.stationGroupId || "any");
      setProductPolicy(product.creditPolicy);
      setProductValidity(product.validityDays ? String(product.validityDays) : "");
      setProductStatus(product.status);
    } else {
      setProductName("");
      setProductCode("");
      setProductQuantity("");
      setProductPrice("");
      setProductGroupId("any");
      setProductPolicy("any_station");
      setProductValidity("");
      setProductStatus("draft");
    }
  }

  async function submitProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!productDialog) return;
    setSavingProduct(true);
    try {
      const { mode, product } = productDialog;

      const res = mode === "create"
        ? await api.rpc.credits.products.$post({
            json: {
              name: productName,
              code: productCode,
              quantityMinutes: parseInt(productQuantity, 10),
              priceAmount: productPrice,
              stationGroupId: productGroupId === "any" ? undefined : productGroupId,
              creditPolicy: productPolicy,
              validityDays: productValidity ? parseInt(productValidity, 10) : undefined,
              unit: "minute",
            }
          })
        : await api.rpc.credits.products[":id"].$patch({
            param: { id: product!.id },
            json: {
              name: productName,
              priceAmount: productPrice,
              stationGroupId: productGroupId === "any" ? undefined : productGroupId,
              creditPolicy: productPolicy,
              validityDays: productValidity ? parseInt(productValidity, 10) : undefined,
              status: productStatus,
            }
          });

      if (res.ok) {
        toast.success(mode === "create" ? "Product created." : "Product updated.");
        setProductDialog(null);
        loadProducts();
      } else {
        const message = await extractError(res as Response, "Could not save product.");
        toast.error(message);
      }
    } finally {
      setSavingProduct(false);
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Credits</h1>
        <p className="text-sm text-muted-foreground">
          Manage member credit lots and credit products.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="pt-4">
          {!selectedMember ? (
            <Stack gap={4}>
              <DataTableToolbar
                q={memberQuery.q}
                onQChange={memberQuery.setQ}
                searchPlaceholder="Search members…"
              />
              <DataTable
                columns={[
                  { key: "name", header: "Name" },
                  { key: "email", header: "Email" },
                  {
                    key: "actions",
                    header: "",
                    render: (row) => (
                      <Button variant="ghost" size="sm" onClick={() => setSelectedMember(row)}>
                        View Credits
                      </Button>
                    )
                  }
                ]}
                rows={members}
                rowKey={(row) => row.id}
                emptyMessage="No members found."
              />
              {memberMeta && (
                <DataTablePagination
                  meta={memberMeta}
                  onPageChange={memberQuery.setPage}
                  onPageSizeChange={memberQuery.setPageSize}
                />
              )}
            </Stack>
          ) : (
            <Stack gap={8}>
              <Row items="center" justify="between">
                <Row items="center" gap={4}>
                  <Button variant="ghost" onClick={() => setSelectedMember(null)}>
                    &larr; Back
                  </Button>
                  <div>
                    <h2 className="text-lg font-medium">{selectedMember.name || selectedMember.email}</h2>
                    <p className="text-sm text-muted-foreground">
                      Total balance: {totalRemainingMinutes} minutes
                    </p>
                  </div>
                </Row>
                <Row gap={2}>
                  <Can permissions={me?.permissions} resource="credit" action="sell">
                    <Button variant="outline" size="sm" onClick={() => openActionDialog("sell")}>
                      Sell
                    </Button>
                  </Can>
                  <Can permissions={me?.permissions} resource="credit" action="grant">
                    <Button variant="outline" size="sm" onClick={() => openActionDialog("grant")}>
                      Grant
                    </Button>
                  </Can>
                  <Can permissions={me?.permissions} resource="credit" action="consume">
                    <Button variant="outline" size="sm" onClick={() => openActionDialog("consume")}>
                      Consume
                    </Button>
                  </Can>
                </Row>
              </Row>

              <div className="space-y-4">
                <h3 className="font-medium">Active Lots</h3>
                {activeLots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active lots.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {activeLots.map(lot => (
                      <div key={lot.id} className="p-4 border rounded-lg space-y-2">
                        <div className="flex justify-between items-start">
                          <Badge variant="secondary" className="capitalize">{lot.status}</Badge>
                          <span className="font-medium">{lot.remainingQuantity} min</span>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1">
                          <p>Original: {lot.originalQuantity} min</p>
                          {lot.expiresAt && <p>Expires: {new Date(lot.expiresAt).toLocaleDateString()}</p>}
                          {lot.stationGroupId && <p>Group: {lot.stationGroupId}</p>}
                          <p>Policy: {lot.creditPolicy === "strict_group_only" ? "Strict Group Only" : "Any Station"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <h3 className="font-medium">Ledger</h3>
                <DataTable
                  columns={[
                    { key: "type", header: "Type", render: (row: CreditLedgerEntry) => <Badge variant="outline" className="capitalize">{row.type}</Badge> },
                    { key: "quantityDelta", header: "Delta", render: (row: CreditLedgerEntry) => (row.quantityDelta > 0 ? `+${row.quantityDelta}` : row.quantityDelta) },
                    { key: "quantityAfter", header: "Balance After" },
                    { key: "reason", header: "Reason" },
                    { key: "createdAt", header: "Date", render: (row: CreditLedgerEntry) => new Date(row.createdAt).toLocaleString() },
                  ]}
                  rows={ledger}
                  rowKey={(row) => row.id}
                  emptyMessage="No ledger entries."
                />
                {ledgerMeta && (
                  <DataTablePagination
                    meta={ledgerMeta}
                    onPageChange={ledgerQuery.setPage}
                    onPageSizeChange={ledgerQuery.setPageSize}
                  />
                )}
              </div>
            </Stack>
          )}
        </TabsContent>

        <TabsContent value="products" className="pt-4">
          <Stack gap={4}>
            <Row items="center" justify="between">
              <h2 className="text-lg font-medium">Credit Products</h2>
              <Can permissions={me?.permissions} resource="credit" action="manageProducts">
                <Button size="sm" onClick={() => openProductDialog("create")}>
                  Create Product
                </Button>
              </Can>
            </Row>

            <DataTable
              columns={[
                { key: "name", header: "Name", sortable: true },
                { key: "code", header: "Code", sortable: true },
                { key: "quantityMinutes", header: "Quantity (min)" },
                { key: "priceAmount", header: "Price" },
                { key: "status", header: "Status", render: (row) => <Badge variant={row.status === "active" ? "success" : "secondary"} className="capitalize">{row.status}</Badge> },
                {
                  key: "actions",
                  header: "",
                  render: (row) => (
                    <Can permissions={me?.permissions} resource="credit" action="manageProducts">
                      <Button variant="ghost" size="sm" onClick={() => openProductDialog("edit", row)}>
                        Edit
                      </Button>
                    </Can>
                  )
                }
              ]}
              rows={products}
              rowKey={(row) => row.id}
              sort={productQuery.sort}
              order={productQuery.order}
              onSortChange={productQuery.setSort}
              emptyMessage="No products found."
            />
            {productMeta && (
              <DataTablePagination
                meta={productMeta}
                onPageChange={productQuery.setPage}
                onPageSizeChange={productQuery.setPageSize}
              />
            )}
          </Stack>
        </TabsContent>
      </Tabs>

      {/* Action Dialog (Sell/Grant/Consume) */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && setActionDialog(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.type === "sell" ? "Sell Credit Product" : actionDialog?.type === "grant" ? "Grant Credits" : "Consume Credits"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitAction} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {actionDialog?.type === "sell" && (
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="product">Product</Label>
                  <Select value={sellProductId} onValueChange={setSellProductId} required>
                    <SelectTrigger><SelectValue placeholder="Select a product" /></SelectTrigger>
                    <SelectContent>
                      {activeProducts.map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.name} ({p.quantityMinutes}m - {p.priceAmount})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {actionDialog?.type !== "sell" && (
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity (minutes)</Label>
                  <Input id="quantity" type="number" value={quantityMinutes} onChange={e => setQuantityMinutes(e.target.value)} required />
                </div>
              )}

              {actionDialog?.type !== "sell" && (
                <div className="space-y-2">
                  <Label htmlFor="group">Station Group (Optional)</Label>
                  <Select value={stationGroupId} onValueChange={setStationGroupId}>
                    <SelectTrigger><SelectValue placeholder="Any station" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any station</SelectItem>
                      {groups.map(g => (
                        <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {actionDialog?.type === "grant" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="policy">Credit Policy</Label>
                    <Select value={creditPolicy} onValueChange={(v: "strict_group_only" | "any_station") => setCreditPolicy(v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any_station">Any Station</SelectItem>
                        <SelectItem value="strict_group_only">Strict Group Only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expiresAt">Expires At (Optional)</Label>
                    <Input id="expiresAt" type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
                  </div>
                </>
              )}

              {actionDialog?.type !== "sell" && (
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="reason">Reason</Label>
                  <Textarea id="reason" value={reason} onChange={e => setReason(e.target.value)} required />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setActionDialog(null)}>Cancel</Button>
              <Button type="submit" disabled={savingAction}>{savingAction ? "Saving..." : "Confirm"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>


      {/* Product Create/Edit Dialog */}
      <Dialog open={!!productDialog} onOpenChange={(open) => !open && setProductDialog(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{productDialog?.mode === "create" ? "Create Product" : "Edit Product"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitProduct} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="pName">Name</Label>
                <Input id="pName" value={productName} onChange={e => setProductName(e.target.value)} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pCode">Code</Label>
                <Input id="pCode" value={productCode} onChange={e => setProductCode(e.target.value)} disabled={productDialog?.mode === "edit"} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pQuantity">Quantity (minutes)</Label>
                <Input id="pQuantity" type="number" value={productQuantity} onChange={e => setProductQuantity(e.target.value)} disabled={productDialog?.mode === "edit"} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pPrice">Price Amount</Label>
                <Input id="pPrice" type="text" placeholder="0.00" value={productPrice} onChange={e => setProductPrice(e.target.value)} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pGroup">Station Group</Label>
                <Select value={productGroupId} onValueChange={setProductGroupId}>
                  <SelectTrigger><SelectValue placeholder="Any station" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any station</SelectItem>
                    {groups.map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pPolicy">Credit Policy</Label>
                <Select value={productPolicy} onValueChange={(v: "strict_group_only" | "any_station") => setProductPolicy(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any_station">Any Station</SelectItem>
                    <SelectItem value="strict_group_only">Strict Group Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pValidity">Validity (Days) - Optional</Label>
                <Input id="pValidity" type="number" value={productValidity} onChange={e => setProductValidity(e.target.value)} />
              </div>
              {productDialog?.mode === "edit" && (
                <div className="space-y-2">
                  <Label htmlFor="pStatus">Status</Label>
                  <Select value={productStatus} onValueChange={(v: "draft" | "active" | "archived") => setProductStatus(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setProductDialog(null)}>Cancel</Button>
              <Button type="submit" disabled={savingProduct}>{savingProduct ? "Saving..." : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
