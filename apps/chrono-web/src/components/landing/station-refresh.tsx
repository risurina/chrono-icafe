"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Row, Button } from "agora/ui";
import { cn } from "agora/ui/cn";

/**
 * The station board's live marker and manual refresh.
 *
 * Its own `"use client"` island so `TenantStations` stays a server component —
 * the board itself needs no interactivity, only this control does.
 *
 * Refresh is **manual only**: no interval, no countdown. `/public/stations`
 * holds a 10s server-side cache, so a ticking timer mostly re-served the same
 * snapshot while pulling the eye to the least useful thing on screen. A visitor
 * who wants to re-check presses the button.
 *
 * `router.refresh()` re-runs the server render, which re-reads the endpoint.
 */
export function StationRefresh({ totalLabel }: { totalLabel?: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <Row
      items="center"
      gap={3}
      className="shrink-0 rounded-full border border-border px-4 py-2"
    >
      <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-chart-2" />
      <span className="text-[10px] font-black uppercase tracking-widest text-chart-2">
        Live
      </span>
      {totalLabel ? (
        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
          {totalLabel}
        </span>
      ) : null}
      <Button
        variant="outline"
        size="icon"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        aria-label="Refresh station availability"
        className="h-8 w-8 border-0 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
      >
        <RefreshCw className={cn("h-4 w-4", pending && "animate-spin")} aria-hidden />
      </Button>
    </Row>
  );
}
