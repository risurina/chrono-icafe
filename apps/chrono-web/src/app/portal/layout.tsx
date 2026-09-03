"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantPortalLayout } from "./tenant-portal-layout";
import { GlobalPortalLayout } from "./global-portal-layout";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? (
    <TenantPortalLayout>{children}</TenantPortalLayout>
  ) : (
    <GlobalPortalLayout>{children}</GlobalPortalLayout>
  );
}
