"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Stack,
  Stepper,
  StepperProgress,
  type Step,
} from "agora/ui";
import { api } from "@/lib/rpc";
import type { OnboardingChecklistItemState, OnboardingChecklistState } from "agora";
import { CreateBranchStep } from "@/components/dashboard/onboarding/steps/create-branch-step";
import { AddStationGroupStep } from "@/components/dashboard/onboarding/steps/add-station-group-step";
import { AddStationStep } from "@/components/dashboard/onboarding/steps/add-station-step";
import { InviteStaffStep } from "@/components/dashboard/onboarding/steps/invite-staff-step";
import { AddProductsStep } from "@/components/dashboard/onboarding/steps/add-products-step";
import { PairDeviceStep } from "@/components/dashboard/onboarding/steps/pair-device-step";
import { OpenShiftStep } from "@/components/dashboard/onboarding/steps/open-shift-step";

const STEP_FORMS: Record<
  string,
  (props: { item: OnboardingChecklistItemState; onDone: () => void }) => React.ReactNode
> = {
  createBranch: CreateBranchStep,
  addStationGroup: AddStationGroupStep,
  addStation: AddStationStep,
  inviteStaff: InviteStaffStep,
  addProducts: AddProductsStep,
  pairDevice: PairDeviceStep,
  openShift: OpenShiftStep,
};

/**
 * Which step to show is computed fresh from server state every load — the
 * first not-done item, in the order the API already returns (stage order).
 * There is no stored cursor: closing and reopening the browser lands back on
 * the same step only because that item is still not done, never because a
 * choice was remembered anywhere.
 */
function firstIncompleteKey(items: OnboardingChecklistItemState[]): string | undefined {
  return items.find((i) => !i.done)?.key;
}

export default function OnboardingSetupPage() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingChecklistState | null>(null);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    const res = await api.rpc.onboarding.checklist.$get();
    if (!res.ok) return;
    const body = await res.json();
    setState(body);
    setActiveKey((prev) => {
      // Keep the user's manual step selection if it still exists and isn't
      // done; otherwise fall back to the first incomplete item — never a
      // stored value from a previous session.
      if (prev && body.items.some((i) => i.key === prev && !i.done)) return prev;
      const hashKey = window.location.hash.replace("#", "");
      if (hashKey && body.items.some((i) => i.key === hashKey)) return hashKey;
      return firstIncompleteKey(body.items);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!state) return null;

  if (state.dismissed || state.allDone) {
    return (
      <Stack className="mx-auto max-w-lg items-center text-center">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>You&apos;re all set</CardTitle>
            <CardDescription>Every setup step is complete — time to trade.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/admin")}>Go to dashboard</Button>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  const activeItem = state.items.find((i) => i.key === activeKey) ?? state.items[0];
  const steps: Step[] = state.items.map((item) => ({
    key: item.key,
    label: item.label,
    status: item.done
      ? "done"
      : item.key === activeItem?.key
        ? "current"
        : item.actionable
          ? "upcoming"
          : "locked",
  }));

  const StepForm = activeItem ? STEP_FORMS[activeItem.key] : undefined;

  // Passing over a skippable-but-not-done step just moves the wizard's
  // cursor forward — it never marks the item done, so it still shows on
  // the stepper and in `completedCount` until its own probe passes.
  function skipActiveItem() {
    if (!activeItem) return;
    const idx = state!.items.findIndex((i) => i.key === activeItem.key);
    const next = state!.items.slice(idx + 1).find((i) => !i.done);
    setActiveKey(next?.key);
  }

  return (
    <Stack gap={6}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get set up</h1>
        <p className="text-sm text-muted-foreground">
          A few quick steps before this business can start trading.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Stepper steps={steps} onStepClick={setActiveKey} />
        <StepperProgress current={state.completedCount} total={state.total} />
      </div>

      {activeItem ? (
        <Card>
          <CardHeader>
            <CardTitle>{activeItem.label}</CardTitle>
            <CardDescription>{activeItem.description}</CardDescription>
          </CardHeader>
          <CardContent>
            {StepForm ? <StepForm item={activeItem} onDone={load} /> : null}
          </CardContent>
          {!activeItem.done && activeItem.wizardStep?.skippable ? (
            <CardFooter>
              <Button variant="ghost" size="sm" onClick={skipActiveItem}>
                Skip for now
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}
    </Stack>
  );
}
