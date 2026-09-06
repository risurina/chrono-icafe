"use client";

import * as React from "react";
import { Share2 } from "lucide-react";
import { Button, toast } from "agora/ui";
import { track } from "@/lib/analytics";

/**
 * Share this venue's public page.
 *
 * Its own `"use client"` island so the section around it stays server-rendered,
 * mirroring `StationRefresh`.
 *
 * Web Share API where it exists (which is where sharing actually happens — a
 * phone), falling back to the clipboard plus a toast. Both are feature-detected
 * at click time, not at render, so the button never renders differently between
 * the server and the client. Deliberately no Facebook/Messenger/Discord SDK:
 * the OS share sheet already reaches all of them, and this repo has no
 * platform-specific share integration to be consistent with.
 *
 * The URL is read from `window.location` rather than passed in, so it is always
 * the page the visitor is actually on — including a tenant's custom domain.
 */
export function ShareButton({
  tenantName,
  label = "Share this gaming cafe",
}: {
  tenantName: string;
  label?: string;
}) {
  const [busy, setBusy] = React.useState(false);

  async function share() {
    if (busy) return;
    setBusy(true);
    try {
      const url = window.location.href;
      if (typeof navigator.share === "function") {
        // The OS sheet is its own confirmation — no toast on this path.
        await navigator.share({ title: tenantName, url });
        track("TENANT_SHARE", { tenantName, method: "native" });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast.success("Link copied");
        track("TENANT_SHARE", { tenantName, method: "clipboard" });
        return;
      }
      toast.error("Sharing is not supported on this browser");
    } catch (err) {
      // A user dismissing the native share sheet rejects with AbortError. That
      // is not a failure and must not raise an error toast.
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error("Could not share this link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      onClick={share}
      disabled={busy}
      className="h-12 rounded-full px-8 text-xs font-black uppercase tracking-widest"
      data-testid="tenant-share-button"
    >
      <Share2 className="mr-2 h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}
