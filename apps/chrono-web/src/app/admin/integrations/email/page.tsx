"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
    Button,
  Input,
  Label,
  Badge,
  Field,
  Stack,
    Can,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  Switch,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import type {
  EmailAccount,
  NotificationJob,
  EmailAccountProvider,
} from "agora/contracts";
import { usePlatformPermissions } from "../../layout";

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

function ConnectionBadge({ status }: { status: EmailAccount["connectionStatus"] }) {
  switch (status) {
    case "connected":
      return <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:bg-emerald-500/20 dark:text-emerald-400 dark:hover:bg-emerald-500/30">Connected</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    case "disconnected":
    default:
      return <Badge variant="secondary">Disconnected</Badge>;
  }
}

export default function EmailIntegrationsPage() {
  const permissions = usePlatformPermissions();
  const [accounts, setAccounts] = useState<EmailAccount[] | null>(null);
  const [jobs, setJobs] = useState<NotificationJob[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [provider, setProvider] = useState<EmailAccountProvider | "">("");
  const [label, setLabel] = useState("");
  const [priority, setPriority] = useState<number>(1);
  const [fromConfig, setFromConfig] = useState("");
  const [domainConfig, setDomainConfig] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);

  
  async function load() {
    setError(null);
    try {
      const [accountsRes, jobsRes] = await Promise.all([
        adminApi["rpc-admin"].integrations.email.accounts.$get(),
        adminApi["rpc-admin"].integrations.email.jobs.$get(),
      ]);

      if (!accountsRes.ok || !jobsRes.ok) {
        throw new Error("Failed to load data.");
      }

      const [accountsData, jobsData] = await Promise.all([
        accountsRes.json(),
        jobsRes.json(),
      ]);

      setAccounts((accountsData.accounts ?? []) as EmailAccount[]);
      setJobs((jobsData.jobs ?? []) as NotificationJob[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetForm() {
    setEditingId(null);
    setProvider("");
    setLabel("");
    setPriority(accounts ? Math.min(accounts.length + 1, 3) : 1);
    setFromConfig("");
    setDomainConfig("");
    setSecret("");
    setEnabled(true);
  }

  function openEdit(acc: EmailAccount) {
    setEditingId(acc.id);
    setProvider(acc.provider);
    setLabel(acc.label);
    setPriority(acc.priority);
    setFromConfig(acc.config.from ?? "");
    setDomainConfig(acc.config.domain ?? "");
    setSecret(""); // clear read-only secret
    setEnabled(acc.enabled);
    setIsAddDialogOpen(true);
  }

  async function handleSave() {
    if (!provider || !label || priority < 1 || priority > 3) {
      toast.error("Please fill in required fields correctly.");
      return;
    }

    setPending(true);
    try {
      const config = {
        from: fromConfig || undefined,
        domain: domainConfig || undefined,
      };

      if (editingId) {
        const res = await adminApi["rpc-admin"].integrations.email.accounts[":id"].$patch({
          param: { id: editingId },
          json: {
            provider: provider as EmailAccountProvider,
            label,
            priority,
            config,
            enabled,
            secret: secret || undefined,
          },
        });
        if (!res.ok) {
          const e: unknown = await res.json().catch(() => null);
          throw new Error(errorMessage(e, "Failed"));
        }
        toast.success("Account updated.");
      } else {
        const res = await adminApi["rpc-admin"].integrations.email.accounts.$post({
          json: {
            provider: provider as EmailAccountProvider,
            label,
            priority,
            config,
            enabled,
            secret: secret || undefined,
          },
        });
        if (!res.ok) {
          const e: unknown = await res.json().catch(() => null);
          throw new Error(errorMessage(e, "Failed"));
        }
        toast.success("Account created.");
      }
      setIsAddDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(id: string) {
    setPending(true);
    try {
      const res = await adminApi["rpc-admin"].integrations.email.accounts[":id"].$delete({
        param: { id },
      });
      if (!res.ok) {
        const e: unknown = await res.json().catch(() => null);
        throw new Error(errorMessage(e, "Failed"));
      }
      toast.success("Account deleted.");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  async function handleTest(id: string) {
    setPending(true);
    try {
      const res = await adminApi["rpc-admin"].integrations.email.accounts[":id"].test.$post({
        param: { id },
      });
      if (!res.ok) {
        const e: unknown = await res.json().catch(() => null);
        throw new Error(errorMessage(e, "Failed"));
      }
      const data: unknown = await res.json();
      toast.success(
        data && typeof data === "object" && "message" in data && typeof (data as { message?: unknown }).message === "string"
          ? (data as { message: string }).message
          : "Tested connection.",
      );
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  if (!accounts || !jobs) {
    return (
      <Stack gap={6}>
        {!error && <p className="text-sm text-muted-foreground">Loading…</p>}
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      <div>
        <Link href="/admin/integrations" className="text-sm text-muted-foreground">
          ← Integrations
        </Link>
        <div className="mt-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Email Failover Accounts</h1>
          <Can permissions={permissions} resource="integration" action="manage">
            <Dialog open={isAddDialogOpen} onOpenChange={v => {
              if (v) resetForm();
              setIsAddDialogOpen(v);
            }}>
              <DialogTrigger asChild>
                <Button disabled={pending || accounts.length >= 3}>
                  Add account
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editingId ? "Edit account" : "Add email account"}</DialogTitle>
                  <DialogDescription>
                    Configure a provider. The priority controls the failover sequence (1 to 3).
                  </DialogDescription>
                </DialogHeader>
                <Stack gap={4} className="py-4">
                  <Field>
                    <Label htmlFor="provider">Provider *</Label>
                    <Select value={provider} onValueChange={(v) => setProvider(v as EmailAccountProvider)} disabled={pending}>
                      <SelectTrigger id="provider">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="resend">Resend</SelectItem>
                        <SelectItem value="sendgrid">SendGrid</SelectItem>
                        <SelectItem value="mailgun">Mailgun</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <Label htmlFor="label">Label *</Label>
                    <Input id="label" value={label} onChange={e => setLabel(e.target.value)} disabled={pending} />
                  </Field>
                  <Field>
                    <Label htmlFor="priority">Priority (1-3) *</Label>
                    <Input id="priority" type="number" min={1} max={3} value={priority} onChange={e => setPriority(parseInt(e.target.value) || 1)} disabled={pending} />
                  </Field>
                  <Field>
                    <Label htmlFor="fromConfig">From Config (optional)</Label>
                    <Input id="fromConfig" value={fromConfig} onChange={e => setFromConfig(e.target.value)} disabled={pending} placeholder="e.g. notifications@acme.com" />
                  </Field>
                  <Field>
                    <Label htmlFor="domainConfig">Domain Config (optional)</Label>
                    <Input id="domainConfig" value={domainConfig} onChange={e => setDomainConfig(e.target.value)} disabled={pending} placeholder="e.g. acme.com" />
                  </Field>
                  <Field>
                    <Label htmlFor="secret">Secret / API Key {editingId ? "(leave blank to keep)" : "*"}</Label>
                    <Input id="secret" type="password" value={secret} onChange={e => setSecret(e.target.value)} disabled={pending} />
                  </Field>
                  <Field className="flex flex-row items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Enabled</Label>
                      <p className="text-sm text-muted-foreground">Is this account active in the failover chain?</p>
                    </div>
                    <Switch checked={enabled} onCheckedChange={setEnabled} disabled={pending} />
                  </Field>
                </Stack>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost" disabled={pending}>Cancel</Button>
                  </DialogClose>
                  <Button onClick={handleSave} disabled={pending}>Save</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Can>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          Configure up to 3 fallback email accounts. When sending an email, we attempt each in priority order (1 is first). 
          A 429 quota error falls over to the next; other errors fail immediately.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>Configured failover accounts</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Priority</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No accounts configured.
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((acc) => (
                <TableRow key={acc.id}>
                  <TableCell>{acc.priority}</TableCell>
                  <TableCell>{acc.label}</TableCell>
                  <TableCell>{acc.provider}</TableCell>
                  <TableCell>
                    <ConnectionBadge status={acc.connectionStatus} />
                  </TableCell>
                  <TableCell>
                    {acc.enabled ? <Badge variant="secondary">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Can permissions={permissions} resource="integration" action="test">
                      <Button variant="ghost" size="sm" onClick={() => handleTest(acc.id)} disabled={pending || !acc.enabled}>Test</Button>
                    </Can>
                    <Can permissions={permissions} resource="integration" action="manage">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(acc)} disabled={pending}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(acc.id)} disabled={pending} className="text-destructive">Delete</Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Notification Jobs</CardTitle>
          <CardDescription>Pending and failed background jobs</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Last Error</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No recent jobs.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.channel}</TableCell>
                  <TableCell>
                    {job.status === "success" ? (
                      <Badge className="bg-emerald-500/15 text-emerald-700">Success</Badge>
                    ) : job.status === "failed" ? (
                      <Badge variant="destructive">Failed</Badge>
                    ) : (
                      <Badge variant="secondary">Pending</Badge>
                    )}
                  </TableCell>
                  <TableCell>{job.attempts}</TableCell>
                  <TableCell className="max-w-[200px] truncate" title={job.lastError || undefined}>
                    {job.lastError || "-"}
                  </TableCell>
                  <TableCell>{new Date(job.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </Stack>
  );
}
