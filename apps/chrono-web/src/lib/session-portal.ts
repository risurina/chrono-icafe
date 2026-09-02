import { tenantFetch } from "agora/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type PortalSession = {
  id: string;
  stationId: string;
  stationName: string;
  status: "active" | "paused";
  startedAt: string;
  scheduledEndAt: string | null;
};

/**
 * Gets the current active session for the authenticated member.
 */
export async function getMyActiveSession(): Promise<{ data: PortalSession | null; error: string | null }> {
  try {
    const res = await tenantFetch()(`${API_URL}/portal/sessions/active`, {
      method: "GET",
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { data: null, error: "Unauthorized" };
      }
      return { data: null, error: "Failed to fetch active session" };
    }
    const { session } = (await res.json()) as { session: PortalSession | null };
    return { data: session, error: null };
  } catch (err: unknown) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "An unknown error occurred",
    };
  }
}
