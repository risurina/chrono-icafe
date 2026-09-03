"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantPortalHome } from "./tenant-portal-home";
import { GlobalPortalHome } from "./global-portal-home";

export default function PortalHomePage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <TenantPortalHome /> : <GlobalPortalHome />;
}
