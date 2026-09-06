"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  buttonVariants,
  Row,
} from "agora/ui";
import { api } from "@/lib/rpc";

const DISMISS_KEY = "chrono.growth.demandBannerDismissed";

/**
 * "Players have been asking for you" — shown to a business that players
 * requested on the public `/discover` page before it joined Chrono.
 *
 * Lives on the tenant dashboard, NOT on the apex `/sign-up` page: the count
 * comes from `GET /rpc/growth/demand`, which sits under `tenantMiddleware()`,
 * and the apex host has no tenant, so an apex caller would 401 before the
 * handler ran.
 *
 * A 403 is a NORMAL response here, not an error: `growth:read` is admin-only,
 * so a staff viewer simply sees nothing. Likewise `count === 0` renders
 * nothing — no empty-state card.
 *
 * Dismissal is per-browser `localStorage`. The foundation's
 * `tenantOnboardingDismissal` table has no `key` column — it is single-purpose,
 * keyed `(tenantId, userId)`, with the row's mere presence as its whole state —
 * so a second dismissal type would need a foundation schema change and a
 * migration. That is not warranted for a marketing acknowledgment. The
 * consequence, accepted deliberately: the banner reappears in a new browser or
 * incognito window, indefinitely, because the demand count never decreases.
 */
export function DemandBanner({
  onAcknowledge,
}: {
  onAcknowledge?: (demandCount: number) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can throw (private mode, blocked site data) — degrade to
      // showing the banner rather than hiding it on an unrelated failure.
      setDismissed(false);
    }

    (async () => {
      const res = await api.rpc.growth.demand.$get();
      // 403 = this viewer lacks growth:read. Expected, silent.
      if (!res.ok) return;
      setCount((await res.json()).count);
    })();
  }, []);

  if (dismissed || count === null || count === 0) return null;

  function acknowledge() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Non-fatal: the banner just returns on the next load.
    }
    onAcknowledge?.(count ?? 0);
    setDismissed(true);
  }

  return (
    <Card data-testid="growth-demand-banner">
      <CardHeader>
        <CardTitle>
          {count === 1
            ? "1 player asked for your business on Chrono"
            : `${count} players asked for your business on Chrono`}
        </CardTitle>
        <CardDescription>
          They searched for you on Chrono&apos;s public discovery page before you
          joined. Publishing your landing page lists your business there so they
          can find you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Row gap={2} wrap>
          <Link
            href="/admin/settings/landing-page"
            className={buttonVariants({ variant: "default" })}
            onClick={acknowledge}
          >
            Set up your public page
          </Link>
          <Link href="/admin/growth" className={buttonVariants({ variant: "outline" })}>
            View details
          </Link>
          <Button variant="ghost" onClick={acknowledge}>
            Dismiss
          </Button>
        </Row>
      </CardContent>
    </Card>
  );
}
