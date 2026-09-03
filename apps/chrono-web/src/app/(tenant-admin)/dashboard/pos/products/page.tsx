"use client";

import { useCallback, useEffect, useState } from "react";
import type { PaginationMeta } from "agora";
import {
  Button,
  Input,
  Label,
  Badge,
  Stack,
  Row,
  Can,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "agora/ui";
import { api } from "@/lib/rpc";

type ProductCategory = "snack" | "drink" | "peripheral" | "other";
type ProductStatus = "active" | "disabled";

type Product = {
  id: string;
  name: string;
  sku: string;
  category: ProductCategory;
  price: string;
  status: ProductStatus;
  trackStock: boolean;
  stockQuantity: number;
  createdAt: string;
  updatedAt: string;
};

type Me = { userId: string; role: string; permissions: Record<string, string[]> };

type FormState = {
  name: string;
  sku: string;
  category: ProductCategory;
  price: string;
  trackStock: boolean;
  stockQuantity: string;
  status: ProductStatus;
};

const EMPTY_FORM: FormState = {
  name: "",
  sku: "",
  category: "other",
  price: "",
  trackStock: false,
  stockQuantity: "0",
  status: "active",
};

function productToForm(p: Product): FormState {
  return {
    name: p.name,
    sku: p.sku,
    category: p.category,
    price: p.price,
    trackStock: p.trackStock,
    stockQuantity: String(p.stockQuantity),
    status: p.status,
  };
}

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function PosProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [restockFor, setRestockFor] = useState<Product | null>(null);
  const [restockQty, setRestockQty] = useState("");
  const query = useListQuery();

  const load = useCallback(async () => {
    const res = await api.rpc.pos.products.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setProducts(body.items as Product[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ userId: body.userId, role: body.role, permissions: body.permissions ?? {} });
      }
    })();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm(productToForm(p));
    setDialogOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.price.trim()) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      sku: form.sku.trim() || undefined,
      category: form.category,
      price: form.price.trim(),
      trackStock: form.trackStock,
      stockQuantity: form.trackStock ? Number(form.stockQuantity) || 0 : undefined,
      status: form.status,
    };
    const res = editing
      ? await api.rpc.pos.products[":id"].$patch({ param: { id: editing.id }, json: payload })
      : await api.rpc.pos.products.$post({ json: payload });
    setSaving(false);
    if (!res.ok) {
      toast.error(
        await extractError(
          res,
          editing ? "Could not update product." : "Could not create product.",
        ),
      );
      return;
    }
    toast.success(editing ? "Product updated." : "Product created.");
    setDialogOpen(false);
    load();
  }

  function openRestock(p: Product) {
    setRestockFor(p);
    setRestockQty("");
  }

  async function submitRestock(e: React.FormEvent) {
    e.preventDefault();
    if (!restockFor) return;
    const quantity = Number(restockQty);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    const res = await api.rpc.pos.products[":id"].restock.$post({
      param: { id: restockFor.id },
      json: { quantity },
    });
    if (!res.ok) {
      toast.error(await extractError(res, "Could not restock product."));
      return;
    }
    toast.success("Product restocked.");
    setRestockFor(null);
    load();
  }

  function renderCategory(p: Product) {
    return <Badge variant="secondary" className="capitalize">{p.category}</Badge>;
  }

  function renderStatus(p: Product) {
    return (
      <Badge variant={p.status === "active" ? "success" : "secondary"}>
        {p.status === "active" ? "Active" : "Disabled"}
      </Badge>
    );
  }

  function renderActions(p: Product) {
    return (
      <Can permissions={me?.permissions} resource="pos" action="manageProducts">
        <Row items="center">
          <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
            Edit
          </Button>
          {p.trackStock ? (
            <Button variant="ghost" size="sm" onClick={() => openRestock(p)}>
              Restock
            </Button>
          ) : null}
        </Row>
      </Can>
    );
  }

  const columns: DataTableColumn<Product>[] = [
    { key: "name", header: "Name", sortable: true },
    { key: "sku", header: "SKU", sortable: true },
    { key: "category", header: "Category", render: renderCategory },
    { key: "price", header: "Price", sortable: true, render: (p) => `₱${p.price}` },
    {
      key: "stockQuantity",
      header: "Stock",
      render: (p) => (p.trackStock ? String(p.stockQuantity) : "—"),
    },
    { key: "status", header: "Status", render: renderStatus },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack gap={8}>
      <Row items="center" justify="between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">Manage the POS retail catalog.</p>
        </div>
        <Can permissions={me?.permissions} resource="pos" action="manageProducts">
          <Button onClick={openCreate}>Add product</Button>
        </Can>
      </Row>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search products…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={products}
          rowKey={(row) => row.id}
          emptyMessage="No products yet."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">{row.sku}</p>
                <p className="text-sm">₱{row.price}</p>
              </div>
              {renderActions(row)}
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={products}
          rowKey={(row) => row.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No products yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "Add product"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sku">SKU (auto-generated if blank)</Label>
              <Input
                id="sku"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as ProductCategory })}
              >
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="snack">Snack</SelectItem>
                  <SelectItem value="drink">Drink</SelectItem>
                  <SelectItem value="peripheral">Peripheral</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="price">Price</Label>
              <Input
                id="price"
                inputMode="decimal"
                placeholder="0.00"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                required
              />
            </div>
            <Row items="center" gap={2}>
              <input
                id="trackStock"
                type="checkbox"
                checked={form.trackStock}
                onChange={(e) => setForm({ ...form, trackStock: e.target.checked })}
              />
              <Label htmlFor="trackStock">Track stock</Label>
            </Row>
            {form.trackStock ? (
              <div className="space-y-2">
                <Label htmlFor="stockQuantity">Starting stock</Label>
                <Input
                  id="stockQuantity"
                  inputMode="numeric"
                  value={form.stockQuantity}
                  onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as ProductStatus })}
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!restockFor} onOpenChange={(open) => !open && setRestockFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restock {restockFor?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitRestock} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="restockQty">Quantity to add</Label>
              <Input
                id="restockQty"
                inputMode="numeric"
                value={restockQty}
                onChange={(e) => setRestockQty(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRestockFor(null)}>
                Cancel
              </Button>
              <Button type="submit">Restock</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
