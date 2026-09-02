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

export function OnboardingChecklistCard({
  state,
  onDismiss,
}: {
  state: OnboardingChecklistState;
  onDismiss: () => void;
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
