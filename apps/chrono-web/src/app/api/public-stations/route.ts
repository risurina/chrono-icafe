import { NextResponse } from "next/server";
import { getRequestTenant } from "agora/next";

export async function GET(request: Request) {
  const tenant = await getRequestTenant();
  
  // No tenant resolved
  if (!tenant.slug && !tenant.host) {
    return new NextResponse(null, { status: 404 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  const url = new URL(`${apiUrl}/public/stations`);

  const headers: Record<string, string> = {
    // Forward the IP for rate limiting if available. Vercel sets x-forwarded-for.
    "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
  };
  
  if (tenant.slug) {
    headers["x-tenant-slug"] = tenant.slug;
  } else if (tenant.host) {
    headers["x-tenant-host"] = tenant.host;
  }

  try {
    const res = await fetch(url.toString(), {
      headers,
      // Pass along the cache-control if any, or rely on the Hono backend's internal cache
    });

    if (!res.ok) {
      return new NextResponse(null, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return new NextResponse(null, { status: 500 });
  }
}
