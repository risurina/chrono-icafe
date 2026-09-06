"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Badge,
  Stack,
  Row,
  Grid,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { STATION_TONE, stationTone } from "@/components/landing/station-tone";
import { track } from "@/lib/analytics";

/**
 * `inUse` counts stations whose status is "occupied" and `unavailable` counts
 * maintenance + offline — the honest split. Both are optional so a payload
 * cached before that change still renders; the per-status counts below are
 * derived from the rows themselves, which are always authoritative.
 */
type StationAggregate = {
  total: number;
  available: number;
  inUse: number;
  occupied?: number;
  unavailable?: number;
};

type PublicStation = {
  id: string;
  name: string;
  stationNumber: string;
  stationType?: string;
  status: string;
};

type PublicBranchStations = {
  id: string;
  name: string;
  code: string;
  aggregate: StationAggregate;
  stations: PublicStation[];
};

type PublicStationData = {
  aggregate: StationAggregate;
  branches: PublicBranchStations[];
};

export function StationAvailabilityPoller({
  initialData,
  venueName,
}: {
  initialData: PublicStationData;
  venueName: string;
}) {
  const [data, setData] = useState<PublicStationData>(initialData);
  const allStations = data.branches.flatMap((b) => b.stations);
  const countOf = (status: string) =>
    allStations.filter((s) => s.status === status).length;

  // Four REAL states, each backed by a real `status` value. This card row used
  // to read "In Use / Offline" over a number the API computed as
  // maintenance + offline — so a machine under maintenance was advertised as in
  // use, and a genuinely-occupied one was counted nowhere.
  const summary = [
    { label: "Total stations", value: data.aggregate.total, tone: "text-foreground" },
    { label: "Available", value: countOf("available"), tone: STATION_TONE.available.text },
    { label: "In use", value: countOf("occupied"), tone: STATION_TONE.occupied.text },
    { label: "Maintenance", value: countOf("maintenance"), tone: STATION_TONE.maintenance.text },
    { label: "Offline", value: countOf("offline"), tone: STATION_TONE.offline.text },
  ];

  useEffect(() => {
    track("TENANT_STATIONS_VIEW", {
      tenantName: venueName,
      totalStations: initialData.aggregate.total,
    });
    // Mount-only: one view per page load, not one per poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/public-stations");
        if (res.ok) {
          const newData = await res.json();
          setData(newData);
        }
      } catch (err) {
        // Silently keep showing the last good data rather than flashing an error toast
      }
    }, 15000); // 15 seconds polling interval

    return () => clearInterval(interval);
  }, []);

  const isEmpty = data.branches.every((branch) => branch.stations.length === 0);

  return (
    <Stack gap={8}>
      <Grid cols={3} gap={4} className="md:grid-cols-5">
        {summary.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className={cn("text-3xl font-bold", card.tone)}>
                {card.value}
              </span>
            </CardContent>
          </Card>
        ))}
      </Grid>

      {isEmpty ? (
        <Stack gap={4} className="py-12 text-center">
          <span className="text-muted-foreground">
            {`No stations listed for ${venueName} yet.`}
          </span>
          {/* Never dead-end: an empty floor is still a reason to sign up. */}
          <Row justify="center" gap={3} wrap>
            <Link
              href="/portal/sign-up"
              className={cn(buttonVariants(), "rounded-full px-6")}
              data-testid="stations-join-cta"
            >
              {`Join ${venueName}`}
            </Link>
            <Link
              href="/"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "rounded-full px-6",
              )}
              data-testid="stations-back-home"
            >
              {`Back to ${venueName}`}
            </Link>
          </Row>
        </Stack>
      ) : (
        <Stack gap={8}>
          {data.branches.map((branch) => (
            <Stack key={branch.id} gap={4}>
              <Row items="baseline" justify="between" gap={2}>
                <span className="text-xl font-semibold">
                  {branch.name}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({branch.code})
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">
                  {`${branch.aggregate.available} of ${branch.aggregate.total} available`}
                </span>
              </Row>
              <Grid cols={3} gap={4} className="grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
                {branch.stations.map((station) => (
                  <Card key={station.id} className="overflow-hidden">
                    {/* Status stripe — semantic token, so it follows the
                        tenant's own theme instead of a fixed green/orange/red. */}
                    <span
                      className={cn(
                        "block h-2 w-full",
                        stationTone(station.status).dot,
                      )}
                      aria-hidden
                    />
                    <CardContent className="p-4">
                      <Stack gap={2} className="text-center">
                        <span className="text-2xl font-bold">
                          {station.stationNumber}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {station.name}
                        </span>
                        <Row justify="center">
                          <Badge
                            variant={
                              station.status === "available"
                                ? "default"
                                : "secondary"
                            }
                            className={cn(stationTone(station.status).text)}
                          >
                            {stationTone(station.status).label}
                          </Badge>
                        </Row>
                        {station.stationType ? (
                          <span className="block text-xs text-muted-foreground">
                            {station.stationType}
                          </span>
                        ) : null}
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
                {branch.stations.length === 0 ? (
                  <span className="col-span-full py-6 text-center text-sm text-muted-foreground">
                    No stations at this branch.
                  </span>
                ) : null}
              </Grid>
            </Stack>
          ))}

          <Row justify="center" gap={3} wrap className="pt-4">
            <Link
              href="/portal/sign-up"
              className={cn(buttonVariants(), "rounded-full px-6")}
              data-testid="stations-join-cta"
            >
              {`Join ${venueName}`}
            </Link>
            <Link
              href="/"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "rounded-full px-6",
              )}
              data-testid="stations-back-home"
            >
              {`Back to ${venueName}`}
            </Link>
          </Row>
        </Stack>
      )}
    </Stack>
  );
}
