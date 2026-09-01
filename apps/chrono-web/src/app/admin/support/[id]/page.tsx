"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CenteredMessage,
  Label,
  Row,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Stack,
  Textarea,
  Can,
  toast,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { adminApi } from "@/lib/admin-client";
import {
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
  type SupportTicketDetail,
  type SupportTicketPriority,
  type SupportTicketStatus,
  type PlatformOrgActivityItem,
} from "agora";
import { usePlatformPermissions } from "../../layout";

const PRIORITY_VARIANT: Record<
  SupportTicketPriority,
  "destructive" | "warning" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

const STATUS_VARIANT: Record<
  SupportTicketStatus,
  "default" | "secondary" | "success" | "outline"
> = {
  open: "default",
  pending: "secondary",
  assigned: "secondary",
  resolved: "success",
  closed: "outline",
};

type StaffOption = { userId: string; name: string; email: string };

export default function SupportTicketDetailPage() {
  const permissions = usePlatformPermissions();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null);
  const [activity, setActivity] = useState<PlatformOrgActivityItem[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const res = await adminApi["rpc-admin"]["support-tickets"][":id"].$get({
      param: { id },
    });
    if ((res.status as number) === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if ((res.status as number) === 404) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      const body = (await res.json()) as SupportTicketDetail;
      setTicket(body);
      // Related system events — reuse the org activity endpoint, not a new feed.
      const act = await adminApi["rpc-admin"].organizations[":id"].activity.$get({
        param: { id: body.organizationId },
      });
      if (act.ok) {
        const ab = await act.json();
        setActivity((ab.items as PlatformOrgActivityItem[]).slice(0, 8));
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Staff picker for "Assign to" — only needed by managers.
  useEffect(() => {
    if (!(permissions.supportTicket ?? []).includes("manage")) return;
    (async () => {
      const res = await adminApi["rpc-admin"].staff.$get();
      if (res.ok) {
        const body = await res.json();
        setStaff(
          (body.items as StaffOption[]).map((s) => ({
            userId: s.userId,
            name: s.name,
            email: s.email,
          })),
        );
      }
    })();
  }, [permissions]);

  async function patch(json: Record<string, unknown>, okMsg: string) {
    const res = await adminApi["rpc-admin"]["support-tickets"][":id"].$patch({
      param: { id },
      json: json as never,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(b?.error ?? "Could not update the ticket.");
      return;
    }
    setTicket((await res.json()) as SupportTicketDetail);
    toast.success(okMsg);
  }

  async function handleStatus(next: SupportTicketStatus) {
    if (!ticket || next === ticket.status) return;
    if (next === "resolved" && !window.confirm("Mark this ticket as resolved?")) return;
    await patch({ status: next }, "Status updated.");
  }

  async function handlePriority(next: SupportTicketPriority) {
    if (!ticket || next === ticket.priority) return;
    await patch({ priority: next }, "Priority updated.");
  }

  async function handleAssign(next: string) {
    await patch(
      { assignedAgentId: next === "unassigned" ? null : next },
      "Assignment updated.",
    );
  }

  async function handlePost() {
    if (!reply.trim()) return;
    setPosting(true);
    const res = await adminApi["rpc-admin"]["support-tickets"][":id"].messages.$post({
      param: { id },
      json: { body: reply, internal },
    });
    setPosting(false);
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(b?.error ?? "Could not post the message.");
      return;
    }
    setTicket((await res.json()) as SupportTicketDetail);
    setReply("");
    setInternal(false);
    toast.success(internal ? "Internal note added." : "Reply added.");
  }

  if (loading) return <CenteredMessage>Loading…</CenteredMessage>;
  if (forbidden)
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            The support console is available to platform staff only.
          </p>
        </CardContent>
      </Card>
    );
  if (notFound || !ticket)
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">This ticket was not found.</p>
          <Link href="/admin/support" className="text-sm text-primary hover:underline">
            Back to the queue
          </Link>
        </CardContent>
      </Card>
    );

  return (
    <Stack>
      <div>
        <Link href="/admin/support" className="text-sm text-primary hover:underline">
          ← Support queue
        </Link>
      </div>

      <Card>
        <CardHeader>
          <Row items="center" justify="between" className="gap-3">
            <CardTitle className="text-xl">{ticket.subject}</CardTitle>
            <Row items="center" className="gap-2">
              <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
              <Badge variant={STATUS_VARIANT[ticket.status]}>{ticket.status}</Badge>
            </Row>
          </Row>
          <CardDescription>
            Tenant:{" "}
            <Link
              href={`/admin/organizations/${ticket.organizationId}`}
              className="text-primary hover:underline"
            >
              {ticket.organizationName ?? ticket.organizationId}
            </Link>
            {" · "}Requester: {ticket.requesterName ?? ticket.requesterLabel ?? "—"}
            {" · "}Opened {new Date(ticket.createdAt).toLocaleString()}
            {" · "}Updated {new Date(ticket.updatedAt).toLocaleString()}
          </CardDescription>
        </CardHeader>
      </Card>

      <Can permissions={permissions} resource="supportTicket" action="manage">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Controls</CardTitle>
          </CardHeader>
          <CardContent>
            <Row className="flex-wrap gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={ticket.status} onValueChange={(v) => handleStatus(v as SupportTicketStatus)}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORT_TICKET_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={ticket.priority}
                  onValueChange={(v) => handlePriority(v as SupportTicketPriority)}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORT_TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Assigned to</Label>
                <Select
                  value={ticket.assignedAgentId ?? "unassigned"}
                  onValueChange={handleAssign}
                >
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {staff.map((s) => (
                      <SelectItem key={s.userId} value={s.userId}>
                        {s.name} ({s.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Row>
          </CardContent>
        </Card>
      </Can>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conversation</CardTitle>
            </CardHeader>
            <CardContent>
              <Stack gap={3}>
                {ticket.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "rounded-md border p-3",
                      m.internal ? "border-warning/40 bg-warning/10" : "bg-card",
                    )}
                  >
                    <Row items="center" justify="between" className="mb-1 gap-2">
                      <span className="text-sm font-medium">
                        {m.authorName ?? "Unknown"}
                      </span>
                      <Row items="center" className="gap-2">
                        {m.internal ? <Badge variant="warning">Internal</Badge> : null}
                        <span className="text-xs text-muted-foreground">
                          {new Date(m.createdAt).toLocaleString()}
                        </span>
                      </Row>
                    </Row>
                    <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                  </div>
                ))}
              </Stack>

              <Can permissions={permissions} resource="supportTicket" action="manage">
                <Stack gap={2} className="mt-4">
                  <Label htmlFor="reply">
                    {internal ? "Add internal note" : "Add reply"}
                  </Label>
                  <Textarea
                    id="reply"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={4}
                    placeholder={
                      internal
                        ? "Visible to staff only"
                        : "Visible in the requester-facing thread"
                    }
                  />
                  <Row items="center" justify="between">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={internal}
                        onChange={(e) => setInternal(e.target.checked)}
                      />
                      Internal note
                    </label>
                    <Button onClick={handlePost} disabled={posting || !reply.trim()}>
                      {posting ? "Posting…" : internal ? "Add note" : "Send reply"}
                    </Button>
                  </Row>
                </Stack>
              </Can>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Related system events</CardTitle>
              <CardDescription>Recent platform activity for this tenant.</CardDescription>
            </CardHeader>
            <CardContent>
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent activity.</p>
              ) : (
                <Stack gap={2}>
                  {activity.map((a) => (
                    <div key={a.id} className="text-xs">
                      <span className="font-medium">
                        {a.kind === "audit" ? a.action : "impersonation"}
                      </span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {new Date(a.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Stack>
  );
}
