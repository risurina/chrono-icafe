"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Row, Button } from "agora/ui";
import { cn } from "agora/ui/cn";

/**
 * The station matrix's live indicator: a countdown that refreshes the server
 * data on expiry, plus a manual refresh.
 *
 * Its own `"use client"` island so `TenantStations` stays a server component —
 * the grid itself needs no interactivity, only this control does.
 *
 * `router.refresh()` re-runs the server render, which re-reads
 * `/public/stations`. That endpoint holds a 10s server-side cache, so the
 * default interval sits above it: a shorter one would just re-serve the same
 * snapshot.
 */
export function StationRefresh({
  intervalSeconds = 30,
  totalLabel,
}: {
  intervalSeconds?: number;
  totalLabel?: string;
}) {
  const router = useRouter();
  const [remaining, setRemaining] = React.useState(intervalSeconds);
  const [pending, startTransition] = React.useTransition();

  const refresh = React.useCallback(() => {
    setRemaining(intervalSeconds);
    startTransition(() => router.refresh());
  }, [intervalSeconds, router]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev > 1) return prev - 1;
        // Refresh outside the state updater — calling it inline would fire
        // twice under StrictMode's double-invoked reducers.
        window.setTimeout(refresh, 0);
        return intervalSeconds;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [intervalSeconds, refresh]);

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
      <span
        className="text-[10px] font-black uppercase tracking-widest text-muted-foreground"
        // The countdown ticks every second; announcing each tick would make a
        // screen reader unusable.
        aria-hidden
      >
        Refresh in {remaining}s
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={refresh}
        disabled={pending}
        aria-label="Refresh station availability"
        className="h-8 w-8 border-0 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
      >
        <RefreshCw className={cn("h-4 w-4", pending && "animate-spin")} aria-hidden />
      </Button>
    </Row>
  );
}
