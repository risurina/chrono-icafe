"use client";

import { ImpersonationBanner as BaseImpersonationBanner } from "agora/ui";
import { adminApi } from "@/lib/admin-client";

// The banner UI + logic is foundation code in `agora/ui`; this shim injects the
// app's typed `/rpc-admin/impersonation/stop` call so the package never imports
// `@agora/api`.
export function ImpersonationBanner() {
  return (
    <BaseImpersonationBanner
      stopImpersonation={() => adminApi["rpc-admin"].impersonation.stop.$post()}
    />
  );
}
