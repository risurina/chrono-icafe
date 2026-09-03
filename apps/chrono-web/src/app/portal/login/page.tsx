"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { TenantLoginForm } from "./tenant-login-form";
import { GlobalLoginForm } from "./global-login-form";

export default function PortalLoginPage() {
  const [isTenant, setIsTenant] = useState<boolean | null>(null);
  useEffect(() => setIsTenant(isTenantHost(window.location.host)), []);
  if (isTenant === null) return <CenteredMessage>Loading…</CenteredMessage>;
  return isTenant ? <TenantLoginForm /> : <GlobalLoginForm />;
}
