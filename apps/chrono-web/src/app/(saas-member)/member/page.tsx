import { GlobalPortalHome } from "./global-portal-home";

/** Apex-only — a tenant host's `/member` is rewritten to `(tenant-member)/player` before this renders. */
export default function PortalHomePage() {
  return <GlobalPortalHome />;
}
