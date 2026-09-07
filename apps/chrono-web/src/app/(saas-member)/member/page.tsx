import { GlobalPortalHome } from "./global-portal-home";

/** Apex-only now — a tenant host's `/portal` redirects to `/member` before this renders. */
export default function PortalHomePage() {
  return <GlobalPortalHome />;
}
