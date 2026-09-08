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
  Label,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "agora/ui";
import {
  getMyInquiries,
  getMyInquiry,
  submitInquiry,
  replyToInquiry,
  type PortalInquiry,
  type PortalInquiryCategory,
  type PortalInquiryMessage,
  type PortalInquiryStatus,
} from "@/lib/member/inquiries";

const STATUS_VARIANT: Record<
  PortalInquiryStatus,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  new: "default",
  assigned: "secondary",
  in_progress: "warning",
  resolved: "success",
  closed: "secondary",
};

const CATEGORY_OPTIONS: { value: PortalInquiryCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "lost_and_found", label: "Lost and found" },
  { value: "feedback", label: "Feedback" },
  { value: "billing", label: "Billing" },
  { value: "session_issue", label: "Session issue" },
  { value: "account", label: "Account" },
];

export default function PortalInquiriesPage() {
  const [inquiries, setInquiries] = useState<PortalInquiry[]>([]);
  const [loading, setLoading] = useState(true);

  const [category, setCategory] = useState<PortalInquiryCategory>("general");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ inquiry: PortalInquiry; messages: PortalInquiryMessage[] } | null>(
    null,
  );
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);

  async function loadList() {
    const { data } = await getMyInquiries({ page: 1, pageSize: 20 });
    if (data) setInquiries(data.items);
    setLoading(false);
  }

  useEffect(() => {
    loadList();
  }, []);

  async function openThread(id: string) {
    setOpenId(id);
    const { data } = await getMyInquiry(id);
    if (data) setThread(data);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;
    setSubmitting(true);
    const { data, error } = await submitInquiry({ category, subject: subject.trim(), message: message.trim() });
    setSubmitting(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Inquiry submitted.");
    setSubject("");
    setMessage("");
    await loadList();
    if (data) openThread(data.inquiry.id);
  }

  async function onReply(e: React.FormEvent) {
    e.preventDefault();
    if (!openId || !reply.trim()) return;
    setReplying(true);
    const { error } = await replyToInquiry(openId, reply.trim());
    setReplying(false);
    if (error) {
      toast.error(error);
      return;
    }
    setReply("");
    openThread(openId);
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inquiries</h1>
        <p className="text-sm text-muted-foreground">Ask us anything — we usually reply within a day.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New inquiry</CardTitle>
          <CardDescription>Submit a question or report an issue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as PortalInquiryCategory)}>
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <Textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} required />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your inquiries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : inquiries.length === 0 ? (
            <p className="text-muted-foreground">No inquiries yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {inquiries.map((i) => (
                <li key={i.id} className="py-2">
                  <button
                    type="button"
                    onClick={() => openThread(i.id)}
                    className="flex w-full items-center justify-between gap-4 text-left"
                  >
                    <div className="min-w-0">
                      <p className="truncate">{i.subject}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {i.category.replace(/_/g, " ")} · {new Date(i.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant={STATUS_VARIANT[i.status]}>{i.status.replace(/_/g, " ")}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {openId && thread ? (
        <Card>
          <CardHeader>
            <CardTitle>{thread.inquiry.subject}</CardTitle>
            <CardDescription>
              <Badge variant={STATUS_VARIANT[thread.inquiry.status]}>
                {thread.inquiry.status.replace(/_/g, " ")}
              </Badge>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-3">
              {thread.messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.authorType === "staff" ? "rounded-lg border bg-muted/40 p-3 mr-8" : "rounded-lg border p-3 ml-8"
                  }
                >
                  <p className="text-xs text-muted-foreground">
                    {m.authorType === "staff" ? "Staff" : "You"} · {new Date(m.createdAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
            <form onSubmit={onReply} className="space-y-2">
              <Label htmlFor="reply">Reply</Label>
              <Textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} required />
              <Button type="submit" disabled={replying || !reply.trim()}>
                {replying ? "Sending…" : "Send reply"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
