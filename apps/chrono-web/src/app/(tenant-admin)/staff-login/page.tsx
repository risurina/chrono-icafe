"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { StaffLoginForm } from "@/components/staff-login-form";

/**
 * Staff sign-in for this business, served at `/admin/login` on a tenant host
 * via the `next.config` rewrite. The physical route is `/staff-login` so it
 * sits outside `(tenant-admin)/dashboard/layout.tsx`'s session gate (a login
 * page nested under that layout would redirect to itself). Apex hits fall
 * back to the apex `/login`, which handles staff with no tenant context yet.
 */
export default function TenantStaffLoginPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);

  useEffect(() => {
    const tenant = isTenantHost(window.location.host);
    setIsTenant(tenant);
    if (!tenant) window.location.replace("/login");
  }, []);

  if (isTenant !== true) return <CenteredMessage>Loading…</CenteredMessage>;
  return <StaffLoginForm customerLoginHref="/login" />;
}
