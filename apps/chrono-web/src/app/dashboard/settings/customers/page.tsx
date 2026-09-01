"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Stack,
  Row,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { PaginationMeta } from "agora";

type Customer = {
  id: string;
  email: string;
  name: string;
  status: "active" | "suspended";
  createdAt: string;
};

export default function CustomersSettingsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [newCust, setNewCust] = useState({ email: "", name: "", password: "" });
  const [editCust, setEditCust] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const query = useListQuery();

  const loadAll = useCallback(async () => {
    const cu = await api.rpc.customers.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (cu.ok) {
      const body = await cu.json();
      setCustomers(body.items as Customer[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await api.rpc.customers.$post({ json: newCust });
    if (res.ok) {
      setNewCust({ email: "", name: "", password: "" });
      loadAll();
      setMsg("Customer created.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can create customers.");
    } else if ((res.status as number) === 409) {
      setMsg("A customer with that email already exists.");
    } else {
      setMsg("Could not create the customer.");
    }
  }

  async function saveCustomerEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editCust) return;
    setMsg(null);
    const res = await api.rpc.customers[":id"].$patch({
      param: { id: editCust.id },
      json: { name: editCust.name, email: editCust.email },
    });
    if (res.ok) {
      setEditCust(null);
      loadAll();
      setMsg("Customer updated.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can edit customers.");
    } else if ((res.status as number) === 409) {
      setMsg("A customer with that email already exists.");
    } else {
      setMsg("Could not update the customer.");
    }
  }

  async function setCustomerSuspended(id: string, suspend: boolean) {
    setMsg(null);
    const res = suspend
      ? await api.rpc.customers[":id"].suspend.$post({ param: { id } })
      : await api.rpc.customers[":id"].reactivate.$post({ param: { id } });
    if (res.ok) {
      loadAll();
      setMsg(suspend ? "Customer suspended." : "Customer reactivated.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can change a customer's status.");
    } else {
      setMsg("Could not update the customer.");
    }
  }

  async function exportCustomer(id: string, email: string) {
    setMsg(null);
    const res = await api.rpc.customers[":id"].export.$get({ param: { id } });
    if (!res.ok) {
      setMsg(
        (res.status as number) === 403
          ? "Only admins can export customer data."
          : "Could not export this customer.",
      );
      return;
    }
    const bundle = await res.json();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-${email}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Customer data exported.");
  }

  async function deleteCustomer(id: string) {
    setMsg(null);
    const res = await api.rpc.customers[":id"].$delete({ param: { id } });
    if (res.ok) {
      loadAll();
      setMsg("Customer data deleted.");
    } else if ((res.status as number) === 403) {
      setMsg("Only admins can delete customer data.");
    } else {
      setMsg("Could not delete this customer.");
    }
  }

  return (
    <Stack gap={8}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Create, suspend, or remove customer accounts for this tenant.
        </p>
      </div>

      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}

      {/* Customers (DSAR — admin only; server enforces the admin role) */}
      <Card>
        <CardHeader>
          <CardTitle>Customers</CardTitle>
          <CardDescription>
            Create, suspend, or remove customer accounts, and export a customer&apos;s
            data on request (admin only).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={createCustomer} className="flex flex-wrap gap-2">
            <Input
              type="email"
              placeholder="customer@example.com"
              className="min-w-40 flex-1"
              value={newCust.email}
              onChange={(e) => setNewCust((s) => ({ ...s, email: e.target.value }))}
              required
            />
            <Input
              placeholder="Full name"
              className="min-w-32 flex-1"
              value={newCust.name}
              onChange={(e) => setNewCust((s) => ({ ...s, name: e.target.value }))}
              required
            />
            <Input
              type="password"
              placeholder="Temp password"
              className="min-w-32 flex-1"
              value={newCust.password}
              onChange={(e) => setNewCust((s) => ({ ...s, password: e.target.value }))}
              required
            />
            <Button type="submit">Create</Button>
          </form>

          <DataTableToolbar
            q={query.q}
            onQChange={query.setQ}
            searchPlaceholder="Search customers…"
            view={query.view}
            onViewChange={query.setView}
          />

          {(() => {
            const renderRow = (cust: Customer) => {
              if (editCust?.id === cust.id) {
                return (
                  <form
                    onSubmit={saveCustomerEdit}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Input
                      placeholder="Full name"
                      className="min-w-32 flex-1"
                      value={editCust.name}
                      onChange={(e) =>
                        setEditCust((s) => s && { ...s, name: e.target.value })
                      }
                      required
                    />
                    <Input
                      type="email"
                      placeholder="customer@example.com"
                      className="min-w-40 flex-1"
                      value={editCust.email}
                      onChange={(e) =>
                        setEditCust((s) => s && { ...s, email: e.target.value })
                      }
                      required
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditCust(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                );
              }
              return (
                <Row shrink items="center">
                  <Badge
                    variant={cust.status === "active" ? "success" : "warning"}
                    className="capitalize"
                  >
                    {cust.status}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditCust({
                        id: cust.id,
                        name: cust.name,
                        email: cust.email,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCustomerSuspended(cust.id, cust.status === "active")
                    }
                  >
                    {cust.status === "active" ? "Suspend" : "Reactivate"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportCustomer(cust.id, cust.email)}
                  >
                    Export
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteCustomer(cust.id)}
                  >
                    Delete
                  </Button>
                </Row>
              );
            };

            const columns: DataTableColumn<Customer>[] = [
              { key: "name", header: "Name", sortable: true },
              { key: "email", header: "Email", sortable: true },
              { key: "actions", header: "", render: renderRow },
            ];

            return query.view === "grid" ? (
              <DataTableGrid
                rows={customers}
                rowKey={(cust) => cust.id}
                emptyMessage="No customers yet."
                renderCard={(cust) => (
                  <div className="space-y-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{cust.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {cust.email}
                      </p>
                    </div>
                    {renderRow(cust)}
                  </div>
                )}
              />
            ) : (
              <DataTable
                columns={columns}
                rows={customers}
                rowKey={(cust) => cust.id}
                sort={query.sort}
                order={query.order}
                onSortChange={query.setSort}
                emptyMessage="No customers yet."
              />
            );
          })()}

          {meta ? (
            <DataTablePagination
              meta={meta}
              onPageChange={query.setPage}
              onPageSizeChange={query.setPageSize}
            />
          ) : null}
        </CardContent>
      </Card>
    </Stack>
  );
}
