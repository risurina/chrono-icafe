"use client";

import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  buttonVariants,
  Stack,
  Row,
} from "agora/ui";
import { cn } from "agora/ui/cn";

export type OnboardingChecklistItemState = {
  key: string;
  label: string;
  description: string;
  href: string;
  stage: string;
  done: boolean;
  actionable: boolean;
};

export type OnboardingChecklistState = {
  items: OnboardingChecklistItemState[];
  completedCount: number;
  total: number;
  allDone: boolean;
  dismissed: boolean;
};

/**
 * The growth-demand signal for the onboarding card (growth-loop-hardening
 * Phase 7) — resolved separately from `state` (see the doc comment on the
 * `demand` prop below). `null` = not yet resolved, so nothing renders until
 * it settles one way or the other (no flash).
 */
export type OnboardingDemandSignal = { allowed: boolean; count: number };

export function OnboardingChecklistCard({
  state,
  onDismiss,
  demand,
}: {
  state: OnboardingChecklistState;
  onDismiss: () => void;
  /**
   * `allowed: false` — this viewer lacks `growth:read` (a staff role) — shows
   * generic encouragement copy with no number, never the count. `allowed:
   * true, count: 0` also shows the generic copy (nothing notable to
   * surface). Only `allowed: true, count > 0` shows the actual number.
   *
   * Deliberately NOT threaded through `resolveOnboardingState()`'s own
   * response: that parse is a plain (non-strict) Zod schema, so an
   * unrecognized field would be silently stripped. This is fetched
   * separately, client-side, from the already-existing `GET
   * /rpc/growth/demand` — see
   * `apps/chrono-web/src/app/(tenant-admin)/dashboard/page.tsx`.
   */
  demand?: OnboardingDemandSignal | null;
}) {
  const stages = Array.from(new Set(state.items.map((i) => i.stage)));

  return (
    <Card>
      <CardHeader>
        <Row items="center" className="justify-between">
          <div>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              {state.completedCount} of {state.total} steps complete
            </CardDescription>
            {demand ? (
              <p className="mt-1 text-xs font-medium text-muted-foreground">
                {demand.allowed && demand.count > 0
                  ? demand.count === 1
                    ? "1 player has already asked for your business — finish setup and publish your page so they can find you."
                    : `${demand.count} players have already asked for your business — finish setup and publish your page so they can find you.`
                  : "Finish setup and publish your page so players can find your business."}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </Row>
      </CardHeader>
      <CardContent>
        <Stack gap={6}>
          {stages.map((stage) => (
            <Stack key={stage} gap={2}>
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {stage}
              </p>
              <Stack gap={2}>
                {state.items
                  .filter((item) => item.stage === stage)
                  .map((item) => (
                    <Row
                      key={item.key}
                      items="center"
                      className="justify-between gap-4 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "truncate text-sm font-medium",
                            item.done && "text-muted-foreground line-through",
                          )}
                        >
                          {item.label}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                      {item.done ? (
                        <Badge variant="secondary" className="shrink-0">
                          Done
                        </Badge>
                      ) : item.actionable ? (
                        <Link
                          href={item.href}
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" }),
                            "shrink-0",
                          )}
                        >
                          Start
                        </Link>
                      ) : (
                        <Badge variant="outline" className="shrink-0 text-muted-foreground">
                          Ask an admin
                        </Badge>
                      )}
                    </Row>
                  ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
