export type PaginationMeta = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startItem: number;
  endItem: number;
  sort: string;
  order: "asc" | "desc";
};

/** Minutes → "Xh Ym" (or "Ym" under an hour), matching the reference hero's format. */
export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${rest}m`;
}

export function formatSeconds(totalSeconds: number): string {
  return formatMinutes(totalSeconds / 60);
}

export function formatCurrency(amount: string | number, currency = "PHP"): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(value)) return amount.toString();
  return new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(value);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
