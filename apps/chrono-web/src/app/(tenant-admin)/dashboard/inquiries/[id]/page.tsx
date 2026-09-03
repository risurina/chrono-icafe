"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import {
  Badge,
  Stack,
  Row,
  Button,
  Label,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
  Can,
} from "agora/ui";
import { api } from "@/lib/rpc";

type Status = "new" | "assigned" | "in_progress" | "resolved" | "closed";

type Inquiry = {
  id: string;
  submitterName: string;
  submitterEmail: string;
  submitterPhone: string | null;
  category: string;
  subject: string;
  status: Status;
  assignedToUserId: string | null;
  createdAt: string;
};

type Message = {
  id: string;
  authorType: "staff" | "customer";
  authorUserId: string | null;
  body: string;
  createdAt: string;
};

type Member = { id: string; userId: string; name: string; email: string };
type Me = { permissions: Record<string, string[]> };

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "destructive" | "success" | "warning"> = {
  new: "default",
  assigned: "secondary",
  in_progress: "warning",
  resolved: "success",
  closed: "secondary",
};

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export default function InquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);

  const [inquiry, setInquiry] = useState<Inquiry | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [assigning, setAssigning] = useState(false);

  async function load() {
    const res = await api.rpc.inquiries[":id"].$get({ param: { id } });
    if (res.ok) {
      const body = await res.json();
      setInquiry(body.inquiry as Inquiry);
      setMessages(body.messages as Message[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    (async () => {
      const res = await api.rpc.members.$get({ query: { pageSize: "100" } });
      if (res.ok) {
        const body = await res.json();
        setMembers(body.items as Member[]);
      }
    })();
    (async () => {
      const res = await api.rpc.me.$get();
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe({ permissions: body.permissions ?? {} });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function memberName(userId: string | null): string {
    if (!userId) return "Unassigned";
    return members.find((m) => m.userId === userId)?.name ?? userId;
  }

  async function submitReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setReplying(true);
    const res = await api.rpc.inquiries[":id"].reply.$post({
      param: { id },
      json: { body: reply.trim() },
    });
    setReplying(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not send reply."));
      return;
    }
    toast.success("Reply sent.");
    setReply("");
    load();
  }

  async function changeStatus(status: Status) {
    if (status === "new") return; // "new" is set only on creation, never a manual target.
    setChangingStatus(true);
    const res = await api.rpc.inquiries[":id"].status.$patch({
      param: { id },
      json: { status },
    });
    setChangingStatus(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not change status."));
      return;
    }
    toast.success("Status updated.");
    load();
  }

  async function assign(userId: string) {
    setAssigning(true);
    const res = await api.rpc.inquiries[":id"].assign.$post({
      param: { id },
      json: { assignedToUserId: userId },
    });
    setAssigning(false);
    if (!res.ok) {
      toast.error(await extractError(res, "Could not assign this inquiry."));
      return;
    }
    toast.success("Inquiry assigned.");
    load();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!inquiry) return <p className="text-sm text-muted-foreground">Inquiry not found.</p>;

  return (
    <Stack>
      <Row items="center" className="justify-between">
        <div>
          <Link href="/dashboard/inquiries" className="text-sm text-muted-foreground underline underline-offset-4">
            ← Back to inquiries
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{inquiry.subject}</h1>
          <p className="text-sm text-muted-foreground">
            {inquiry.submitterName} · {inquiry.submitterEmail}
            {inquiry.submitterPhone ? ` · ${inquiry.submitterPhone}` : ""}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[inquiry.status]}>{inquiry.status.replace(/_/g, " ")}</Badge>
      </Row>

      <Can permissions={me?.permissions} resource="inquiry" action="manage">
        <Row items="center">
          <div className="w-56">
            <Label>Assigned to</Label>
            <Select
              value={inquiry.assignedToUserId ?? ""}
              onValueChange={assign}
              disabled={assigning}
            >
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-48">
            <Label>Status</Label>
            <Select
              value={inquiry.status}
              onValueChange={(v) => changeStatus(v as Status)}
              disabled={changingStatus}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assigned">Assigned</SelectItem>
                <SelectItem value="in_progress">In progress</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Row>
      </Can>

      <Stack className="gap-3">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={
                m.authorType === "staff"
                  ? "rounded-lg border bg-muted/40 p-3 ml-8"
                  : "rounded-lg border p-3 mr-8"
              }
            >
              <p className="text-xs text-muted-foreground">
                {m.authorType === "staff" ? memberName(m.authorUserId) : inquiry.submitterName} ·{" "}
                {new Date(m.createdAt).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap text-sm">{m.body}</p>
            </div>
          ))
        )}
      </Stack>

      <Can permissions={me?.permissions} resource="inquiry" action="manage">
        <form onSubmit={submitReply} className="space-y-2">
          <Label htmlFor="reply">Reply</Label>
          <Textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} required />
          <Button type="submit" disabled={replying || !reply.trim()}>
            {replying ? "Sending…" : "Send reply"}
          </Button>
        </form>
      </Can>
    </Stack>
  );
}
