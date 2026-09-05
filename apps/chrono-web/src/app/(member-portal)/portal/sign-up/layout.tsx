import { PortalAuthChrome } from "@/components/portal-auth-chrome";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <PortalAuthChrome>{children}</PortalAuthChrome>;
}
