"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "agora/ui";
import { Badge } from "agora/ui";

type PublicStationData = {
  aggregate: {
    total: number;
    available: number;
    inUse: number;
  };
  stations: Array<{
    id: string;
    name: string;
    stationNumber: string;
    stationType?: string;
    status: string;
  }>;
};

export function StationAvailabilityPoller({ initialData }: { initialData: PublicStationData }) {
  const [data, setData] = useState<PublicStationData>(initialData);

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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Stations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{data.aggregate.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Available</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600 dark:text-green-500">{data.aggregate.available}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">In Use / Offline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-600 dark:text-orange-500">{data.aggregate.inUse}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {data.stations.map((station) => (
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
                {station.status === "available" ? "Available" : station.status === "maintenance" ? "Maintenance" : "Offline"}
              </Badge>
              {station.stationType && (
                <div className="text-xs text-muted-foreground">{station.stationType}</div>
              )}
            </CardContent>
          </Card>
        ))}
        {data.stations.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground">
            No stations available.
          </div>
        )}
      </div>
    </div>
  );
}
