"use client";

// Global customer (platform-wide identity) auth for the browser. The
// transport client and the session hook both live in the foundation — this
// module stays as the app's single import point, mirroring member-client.ts.
export {
  customerAuth,
  applyForTenantMembership,
  getMyTenantMemberships,
  type GlobalCustomerUser,
  type GlobalCustomerMembership,
} from "agora/client";
export { useGlobalCustomerSession } from "agora/client/react";
