"use client";

import { useEffect, useState } from "react";
import { isTenantHost } from "agora/client";
import { CenteredMessage } from "agora/ui";
import { GlobalLoginForm } from "./global-login-form";

/** Apex-only global customer login. A tenant host's member login now lives at `/login`. */
export default function PortalLoginPage() {
  const [isApex, setIsApex] = useState<boolean | null>(null);

  useEffect(() => {
    const tenant = isTenantHost(window.location.host);
    setIsApex(!tenant);
    if (tenant) window.location.replace("/login");
  }, []);

  if (isApex !== true) return <CenteredMessage>Loading…</CenteredMessage>;
  return <GlobalLoginForm />;
}
