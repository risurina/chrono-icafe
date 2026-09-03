"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Label,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Can,
  toast,
} from "agora/ui";
import { adminApi } from "@/lib/admin-client";
import { SUPPORT_TICKET_PRIORITIES, type SupportTicketPriority } from "agora";

type OrgOption = { id: string; name: string };

/**
 * "New ticket" entry point for the support console. Platform staff log a ticket
 * on behalf of a tenant, so it carries an org picker + a free-text requester
 * label. Gated on `supportTicket:manage` (visibility only — the route enforces).
 */
export function NewTicketDialog({
  permissions,
  onCreated,
}: {
  permissions: Record<string, string[]>;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<SupportTicketPriority>("normal");
  const [requesterLabel, setRequesterLabel] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const res = await adminApi["rpc-admin"].organizations.$get({
        query: { pageSize: "100" },
      });
      if (res.ok) {
        const body = await res.json();
        setOrgs(
          (body.items as { id: string; name: string }[]).map((o) => ({
            id: o.id,
            name: o.name,
          })),
        );
      }
    })();
  }, [open]);

  async function handleSubmit() {
    if (!organizationId) {
      toast.error("Choose a tenant for this ticket.");
      return;
    }
    setSubmitting(true);
    const res = await adminApi["rpc-admin"]["support-tickets"].$post({
      json: {
        organizationId,
        subject,
        priority,
        requesterLabel: requesterLabel.trim() || undefined,
        body,
      },
    });
    setSubmitting(false);
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(b?.error ?? "Could not create the ticket.");
      return;
    }
    const ticket = await res.json();
    setOpen(false);
    setSubject("");
    setBody("");
    setRequesterLabel("");
    setPriority("normal");
    setOrganizationId("");
    onCreated();
    router.push(`/admin/support/${(ticket as { id: string }).id}`);
  }

  return (
    <Can permissions={permissions} resource="supportTicket" action="manage">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>New ticket</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New support ticket</DialogTitle>
            <DialogDescription>
              Log a ticket on behalf of a tenant. The opening message starts the thread.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org">Tenant</Label>
              <Select value={organizationId} onValueChange={setOrganizationId}>
                <SelectTrigger id="org">
                  <SelectValue placeholder="Select a tenant" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="Short summary of the issue"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(v) => setPriority(v as SupportTicketPriority)}
                >
                  <SelectTrigger id="priority">
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
                <Label htmlFor="requester">Requester (optional)</Label>
                <Input
                  id="requester"
                  value={requesterLabel}
                  onChange={(e) => setRequesterLabel(e.target.value)}
                  maxLength={120}
                  placeholder="e.g. jane@acme.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="body">Opening message</Label>
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="Describe the request or issue"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Creating…" : "Create ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Can>
  );
}
