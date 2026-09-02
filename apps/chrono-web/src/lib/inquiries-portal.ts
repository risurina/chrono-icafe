import { tenantFetch } from "agora/client";
import type { PaginationMeta } from "agora";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type PortalInquiryCategory =
  | "general"
  | "lost_and_found"
  | "feedback"
  | "billing"
  | "session_issue"
  | "account";

export type PortalInquiryStatus = "new" | "assigned" | "in_progress" | "resolved" | "closed";

export type PortalInquiry = {
  id: string;
  category: PortalInquiryCategory;
  subject: string;
  status: PortalInquiryStatus;
  createdAt: string;
};

export type PortalInquiryMessage = {
  id: string;
  authorType: "staff" | "customer";
  body: string;
  createdAt: string;
};

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<{ data: T | null; error: string | null }> {
  const qs = init?.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const res = await tenantFetch()(`${API_URL}/portal/inquiries${path}${qs}`, {
    method: init?.body !== undefined ? init.method ?? "POST" : init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    return { data: null, error: json?.error ?? "Request failed" };
  }
  return { data: json, error: null };
}

export const getMyInquiries = (query: { page: number; pageSize: number }) =>
  call<{ items: PortalInquiry[]; meta: PaginationMeta }>("/", {
    method: "GET",
    query: { page: String(query.page), pageSize: String(query.pageSize) },
  });

export const getMyInquiry = (id: string) =>
  call<{ inquiry: PortalInquiry; messages: PortalInquiryMessage[] }>(`/${id}`, { method: "GET" });

export const submitInquiry = (input: { category: PortalInquiryCategory; subject: string; message: string }) =>
  call<{ inquiry: PortalInquiry }>("/", { method: "POST", body: input });

export const replyToInquiry = (id: string, body: string) =>
  call<{ inquiry: PortalInquiry; message: PortalInquiryMessage }>(`/${id}/reply`, {
    method: "POST",
    body: { body },
  });
