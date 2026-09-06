"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "agora/ui";
import { Badge } from "agora/ui";
import { STATION_TONE, stationTone } from "@/components/landing/station-tone";

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

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {summary.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${card.tone}`}>{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.branches.every((branch) => branch.stations.length === 0) ? (
        <div className="py-12 text-center text-muted-foreground">
          {`No stations listed for ${venueName} yet.`}
        </div>
      ) : (
        <div className="space-y-10">
          {data.branches.map((branch) => (
            <div key={branch.id} className="space-y-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-xl font-semibold">
                  {branch.name} <span className="text-sm font-normal text-muted-foreground">({branch.code})</span>
                </h2>
                <span className="text-sm text-muted-foreground">
                  {branch.aggregate.available} of {branch.aggregate.total} available
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {branch.stations.map((station) => (
                  <Card key={station.id} className="overflow-hidden">
                    <div
                      className={`h-2 w-full ${
                        station.status === "available"
                          ? "bg-green-500"
                          : station.status === "maintenance"
                          ? "bg-orange-500"
                          : "bg-red-500"
                      }`}
                    />
                    <CardContent className="p-4 flex flex-col items-center text-center space-y-2">
                      <div className="text-2xl font-bold">{station.stationNumber}</div>
                      <div className="text-xs text-muted-foreground truncate w-full">{station.name}</div>
                      <Badge
                        variant={station.status === "available" ? "default" : "secondary"}
                        className={
                          station.status === "available"
                            ? "bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900 dark:text-green-100"
                            : station.status === "maintenance"
                            ? "bg-orange-100 text-orange-800 hover:bg-orange-100 dark:bg-orange-900 dark:text-orange-100"
                            : "bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900 dark:text-red-100"
                        }
                      >
                        {stationTone(station.status).label}
                      </Badge>
                      {station.stationType && (
                        <div className="text-xs text-muted-foreground">{station.stationType}</div>
                      )}
                    </CardContent>
                  </Card>
                ))}
                {branch.stations.length === 0 && (
                  <div className="col-span-full py-6 text-center text-sm text-muted-foreground">
                    No stations at this branch.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
