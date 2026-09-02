import { tenantFetch } from "agora/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type MemberApplicationStatus = "pending" | "approved" | "rejected";

export type MemberProfile = {
  applicationStatus: MemberApplicationStatus;
  phone: string | null;
};

export type MemberOnboarding = {
  applicationStatus: MemberApplicationStatus;
  appliedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  wallet: { balance: string; currency: string; exists: boolean };
  memberRateEligible: boolean;
};

async function call<T>(
  path: string,
  body?: unknown,
): Promise<{ data: T | null; error: string | null }> {
  const res = await tenantFetch()(`${API_URL}/portal/members${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as
    | { profile?: T; error?: string }
    | null;
  if (!res.ok) return { data: null, error: json?.error ?? "Request failed" };
  return { data: (json?.profile ?? null) as T | null, error: null };
}

export const getMyMembership = () => call<MemberProfile>("/me");
export const applyForMembership = (phone?: string) =>
  call<MemberProfile>("/apply", { phone });

/** customer-onboarding Phase 2's read route — own state only, never `profile`-keyed
 * like the two calls above (the API returns the onboarding shape at the top level). */
export async function getMyOnboarding(): Promise<{
  data: MemberOnboarding | null;
  error: string | null;
}> {
  const res = await tenantFetch()(`${API_URL}/portal/members/me/onboarding`);
  const json = (await res.json().catch(() => null)) as
    | (MemberOnboarding & { error?: string })
    | null;
  if (!res.ok) return { data: null, error: json?.error ?? "Request failed" };
  return { data: json, error: null };
}
