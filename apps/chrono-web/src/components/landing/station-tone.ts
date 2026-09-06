/**
 * The public station-status vocabulary and its presentation tokens.
 *
 * Four states, matching `chronoStationStatusSchema` exactly — the values the
 * database actually holds, including `occupied`, which sessions write. Kept in
 * its own module so the server-rendered landing sections and the `/stations`
 * client poller share one source for both the labels and the colours; a second
 * copy is how the two surfaces drifted into disagreeing about what "in use"
 * meant in the first place.
 *
 * Colours are semantic tokens only — never `bg-green-500`-style literals, which
 * do not follow the tenant's theme (`.ai/rules/styling.md`).
 */
export const STATION_TONE = {
  available: { dot: "bg-chart-2", text: "text-chart-2", label: "Available" },
  occupied: { dot: "bg-primary", text: "text-primary", label: "In use" },
  maintenance: { dot: "bg-chart-4", text: "text-chart-4", label: "Maintenance" },
  offline: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    label: "Offline",
  },
} as const;

export type StationStatus = keyof typeof STATION_TONE;

/** The tone for a raw wire value, degrading an unknown one to `offline`. */
export function stationTone(status: string) {
  return STATION_TONE[status as StationStatus] ?? STATION_TONE.offline;
}
