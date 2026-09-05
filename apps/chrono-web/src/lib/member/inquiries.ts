import { api, unwrap, type Result } from "./client";
import type { PaginationMeta } from "./format";

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

export function getMyInquiries(query: {
  page: number;
  pageSize: number;
}): Promise<Result<{ items: PortalInquiry[]; meta: PaginationMeta }>> {
  return api.portal.inquiries
    .$get({ query: { page: String(query.page), pageSize: String(query.pageSize) } })
    .then((res) => unwrap(res, (json) => json as { items: PortalInquiry[]; meta: PaginationMeta }));
}

export function getMyInquiry(
  id: string,
): Promise<Result<{ inquiry: PortalInquiry; messages: PortalInquiryMessage[] }>> {
  return api.portal.inquiries[":id"]
    .$get({ param: { id } })
    .then((res) => unwrap(res, (json) => json as { inquiry: PortalInquiry; messages: PortalInquiryMessage[] }));
}

export function submitInquiry(input: {
  category: PortalInquiryCategory;
  subject: string;
  message: string;
}): Promise<Result<{ inquiry: PortalInquiry }>> {
  return api.portal.inquiries
    .$post({ json: input })
    .then((res) => unwrap(res, (json) => json as { inquiry: PortalInquiry }));
}

export function replyToInquiry(
  id: string,
  body: string,
): Promise<Result<{ inquiry: PortalInquiry; message: PortalInquiryMessage }>> {
  return api.portal.inquiries[":id"].reply
    .$post({ param: { id }, json: { body } })
    .then((res) => unwrap(res, (json) => json as { inquiry: PortalInquiry; message: PortalInquiryMessage }));
}
