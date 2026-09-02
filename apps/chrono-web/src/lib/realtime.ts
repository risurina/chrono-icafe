import { connectRealtime, type RealtimeConnection } from "agora/client/realtime";
import type {
  StationStatusEvent,
  BranchSummaryEvent,
  SessionStateEvent,
} from "@agora/chrono-api/realtime";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/** `ws(s)://` variant of the same origin `@/lib/rpc`'s `api` client talks to. */
function apiWsUrl(): string {
  return API_URL.replace(/^http/, "ws");
}

/**
 * Chrono's own thin wrapper over `agora/client`'s `connectRealtime()`, typed
 * against this module's event contracts (`apps/chrono-api/src/modules/
 * realtime/contracts.ts`, exported via the `"./realtime"` package export —
 * see `.ai/plans/chrono/active/realtime-updates/README.md`, Phase 2a).
 */
export function connectChronoRealtime(scopes?: string[]): RealtimeConnection {
  return connectRealtime({ apiWsUrl: apiWsUrl(), scopes });
}

export function onStationStatus(
  connection: RealtimeConnection,
  handler: (event: StationStatusEvent) => void,
): () => void {
  return connection.on("station.status", (payload) => handler(payload as StationStatusEvent));
}

export function onBranchSummary(
  connection: RealtimeConnection,
  handler: (event: BranchSummaryEvent) => void,
): () => void {
  return connection.on("branch.summary", (payload) => handler(payload as BranchSummaryEvent));
}

export function onSessionState(
  connection: RealtimeConnection,
  handler: (event: SessionStateEvent) => void,
): () => void {
  return connection.on("session.state", (payload) => handler(payload as SessionStateEvent));
}
