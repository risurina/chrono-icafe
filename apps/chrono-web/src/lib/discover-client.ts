import type {
  BusinessDirectoryResult,
  DiscoverBusinessesQuery,
  CreateBusinessLeadInput,
} from "@agora/chrono-api/business-lead";

/**
 * Thin typed wrapper over the apex `/public/discover/*` routes.
 *
 * These are unauthenticated, cross-tenant endpoints on the apex host, so they
 * carry NO tenant headers — the same deliberate choice
 * `(apex-marketing)/support/support-form.tsx` makes for
 * `/public/company-inquiries`. `lib/customer-client.ts` is only a re-export
 * barrel of `agora/client` and has nothing to mirror here.
 *
 * It exists so the three `/discover` components share one call site each
 * instead of hand-rolling `fetch` three times.
 */
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
}

export type DiscoverSearchResult =
  | { ok: true; businesses: BusinessDirectoryResult[] }
  | { ok: false; error: string };

export async function searchBusinesses(
  query: DiscoverBusinessesQuery,
  signal?: AbortSignal,
): Promise<DiscoverSearchResult> {
  const params = new URLSearchParams({ q: query.q });
  if (query.city) params.set("city", query.city);

  const res = await fetch(`${apiBase()}/public/discover/businesses?${params}`, {
    signal,
    credentials: "include",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? "Could not search right now. Please try again." };
  }
  return { ok: true, businesses: (await res.json()) as BusinessDirectoryResult[] };
}

/**
 * Submission is anonymous — the route never returns 401. When a global
 * customer happens to be signed in, `credentials: "include"` lets the API
 * pick that session up server-side; the web client neither checks for nor
 * requires it.
 */
export type SubmitLeadResult =
  | { ok: true; id: string }
  | { ok: false; reason: "rate_limited"; error: string }
  | { ok: false; reason: "error"; error: string };

export async function submitBusinessLead(
  input: CreateBusinessLeadInput,
): Promise<SubmitLeadResult> {
  const res = await fetch(`${apiBase()}/public/discover/business-leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  const body = (await res.json().catch(() => null)) as
    | { id?: string; error?: string }
    | null;

  if (res.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      error: body?.error ?? "Too many requests. Try again later.",
    };
  }
  if (!res.ok || !body?.id) {
    return {
      ok: false,
      reason: "error",
      error: body?.error ?? "Could not record your request. Please try again.",
    };
  }
  return { ok: true, id: body.id };
}
