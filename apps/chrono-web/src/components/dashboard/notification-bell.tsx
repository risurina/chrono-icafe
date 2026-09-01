"use client";

import { NotificationBell as BaseNotificationBell } from "agora/ui";
import { api } from "@/lib/rpc";

// The bell UI + logic is foundation code in `agora/ui`; this shim injects the
// app's typed `/rpc/notification-feed` calls so the package never imports
// `@agora/chrono-api`, exactly like `announcement-banner.tsx`'s `onRead` shim.
export function NotificationBell() {
  return (
    <BaseNotificationBell
      fetchFeed={async () => {
        const res = await api.rpc["notification-feed"].$get({
          query: { page: "1", pageSize: "20" },
        });
        if (!res.ok) return null;
        return res.json();
      }}
      onMarkRead={async (id) => {
        await api.rpc["notification-feed"][":id"].read.$post({ param: { id } });
      }}
      onMarkAllRead={async () => {
        await api.rpc["notification-feed"]["mark-all-read"].$post();
      }}
      onReadAnnouncement={(id) => {
        api.rpc.announcements[":id"].read.$post({ param: { id } }).catch(() => {});
      }}
    />
  );
}
