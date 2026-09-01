"use client";

import { api } from "@/lib/rpc";
import { DashboardMeProvider as BaseDashboardMeProvider } from "agora/client/react";

// The provider + `useDashboardMe` hook are foundation logic in
// `agora/client/react`; this shim injects the app's typed `/rpc/me` fetch so the
// package never imports `@agora/chrono-api`. `fetchMe` is module-level (stable) so the
// provider's polling interval is not restarted on every render.
export { useDashboardMe, POLL_INTERVAL_MS } from "agora/client/react";

const fetchMe = () => api.rpc.me.$get();

export function DashboardMeProvider({ children }: { children: React.ReactNode }) {
  return <BaseDashboardMeProvider fetchMe={fetchMe}>{children}</BaseDashboardMeProvider>;
}
