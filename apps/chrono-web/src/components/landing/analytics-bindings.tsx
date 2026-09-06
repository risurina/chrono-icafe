"use client";

import * as React from "react";
import Link from "next/link";
import { track, type AnalyticsEvent, type AnalyticsEventProps } from "@/lib/analytics";

/**
 * Client islands that let the server-rendered landing sections emit analytics
 * without any of them becoming client components themselves.
 */

/**
 * Fire one event once, on mount.
 *
 * `track()` itself persists `props.source` (when present) to `sessionStorage`
 * for the rest of the visit — see `SOURCE_AWARE_EVENTS`/`persistSessionSource`
 * in `lib/analytics.ts`. `TrackOnMount` needs no source-specific logic of its
 * own; the tenant landing page's `TENANT_PAGE_VIEW` call already passes its
 * resolved `?source=` through `props`, same as any other event prop.
 */
export function TrackOnMount<E extends AnalyticsEvent>({
  event,
  props,
}: {
  event: E;
  props: AnalyticsEventProps[E];
}) {
  const fired = React.useRef(false);
  React.useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(event, props);
    // Deliberately mount-only: a page view is one event per render, not one
    // per prop identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** A `next/link` that records an event when it is followed. */
export function TrackedLink<E extends AnalyticsEvent>({
  event,
  props,
  href,
  className,
  target,
  rel,
  children,
  "data-testid": testId,
}: {
  event: E;
  props: AnalyticsEventProps[E];
  href: string;
  className?: string;
  target?: string;
  rel?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Link
      href={href}
      className={className}
      target={target}
      rel={rel}
      data-testid={testId}
      onClick={() => track(event, props)}
    >
      {children}
    </Link>
  );
}
