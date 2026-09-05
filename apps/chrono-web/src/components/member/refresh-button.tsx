"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "agora/ui";
import { cn } from "agora/ui/cn";

/** Manual-refresh affordance — the member area has no polling anywhere
 * (the plan's "Realtime: none for members" decision). */
export function RefreshButton({
  onRefresh,
  className,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);

  async function onClick() {
    setLoading(true);
    try {
      await onRefresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={loading}
      className={cn("gap-2", className)}
      data-testid="member-refresh-button"
    >
      <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
      Refresh
    </Button>
  );
}
