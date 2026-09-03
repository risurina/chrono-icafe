import { notFound } from "next/navigation";
import { getRequestTenant } from "agora/next";
import { StationAvailabilityPoller } from "./client";

export default async function PublicStationsPage() {
  const tenant = await getRequestTenant();

  if (!tenant.slug && !tenant.host) {
    notFound();
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  const headers: Record<string, string> = {};
  if (tenant.slug) headers["x-tenant-slug"] = tenant.slug;
  else if (tenant.host) headers["x-tenant-host"] = tenant.host;

  // We fetch initial data server-side
  const res = await fetch(`${apiUrl}/public/stations`, {
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    if (res.status === 404) {
      notFound();
    }
    // For other errors, we might want to still render the shell and let the client retry,
    // but typically a server error means we can't render the initial state.
    // Given the requirements, a suspended/unknown tenant MUST render 404.
    // If it's a 500 from the backend, we throw it to boundary or show error.
    // The requirement says "never 500... for unknown or suspended tenant". 
    // The backend returns 404 for suspended. So res.ok will be false and status 404, which correctly calls notFound().
    throw new Error(`Failed to fetch public stations: ${res.statusText}`);
  }

  const initialData = await res.json();

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto p-4 md:p-8 max-w-6xl space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Station Availability</h1>
          <p className="text-muted-foreground mt-2">Live view of available stations</p>
        </div>
        
        <StationAvailabilityPoller initialData={initialData} />
      </main>
    </div>
  );
}
