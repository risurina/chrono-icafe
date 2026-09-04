import Link from "next/link";
import { MapPin } from "lucide-react";
import {
  SiteHeader,
  SiteFooter,
  ThemeToggle,
  Stack,
  Row,
  buttonVariants,
  type FooterColumn,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { ChronoBrand } from "./chrono-brand";

/**
 * Chrono's marketing header and footer, matching the karta-oikos/chrono design.
 *
 * One header and one footer, composed from the foundation primitives — the
 * reference ships three near-identical copies of each with no shared code, and
 * the tenant variants below take props rather than duplicating the markup.
 */

const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Modules", href: "/#modules" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Support", href: "/contact" },
];

export function MarketingHeader() {
  const navLinks = NAV.map((item) => (
    <Link key={item.href} href={item.href} className="hover:text-foreground">
      {item.label}
    </Link>
  ));

  return (
    <SiteHeader
      maxWidth="full"
      // Transparent over the hero, solidifying once scrolled — the behaviour
      // the reference implements by hand in three separate components.
      transparentUntilScroll
      brand={
        <Link href="/" aria-label="Chrono home">
          <ChronoBrand />
        </Link>
      }
      nav={navLinks}
      mobileNav={
        <>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="px-2 py-2">
              {item.label}
            </Link>
          ))}
          <Link href="/login" className="px-2 py-2">
            Login
          </Link>
        </>
      }
      actions={
        <>
          <ThemeToggle />
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: "ghost" }), "hidden sm:inline-flex")}
          >
            Login
          </Link>
          <Link
            href="/contact"
            className={cn(
              buttonVariants(),
              // Semantic `bg-primary` via the default variant, not the
              // reference's hardcoded `bg-gold` literal.
              "rounded-full px-5 text-[10px] font-bold uppercase tracking-widest",
            )}
            data-testid="marketing-cta"
          >
            Request Private Demo
          </Link>
        </>
      }
    />
  );
}

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: "Platform",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Private Demo", href: "/contact" },
      { label: "Pricing", href: "/#pricing" },
      { label: "Information", href: "/#faq" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

export function MarketingFooter({ year }: { year: number }) {
  return (
    <SiteFooter
      maxWidth="full"
      className="relative overflow-hidden"
      columns={[
        ...FOOTER_COLUMNS,
        {
          heading: "Location",
          links: [{ label: "City Of SJDM, Bulacan · Philippines", href: "/contact" }],
        },
      ]}
      brand={
        <Stack gap={3}>
          <ChronoBrand />
          <span className="max-w-sm text-muted-foreground">
            Business management for gaming centers and internet cafes — sessions,
            wallets, shifts and branch operations in one place.
          </span>
          <Row className="items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            Philippines
          </Row>
        </Stack>
      }
      bottomBar={
        <Row className="flex-col items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.3em] sm:flex-row">
          <span>© {year} Chrono. All rights reserved.</span>
          <span>Designed in PH</span>
        </Row>
      }
    />
  );
}

/**
 * The tenant-branded footer variant. Same component, different props — the
 * reference copies 154 lines to achieve this.
 */
export function TenantFooter({
  year,
  tenantName,
  tagline,
  hidePlatformBranding = false,
  platformBrandingLabel = "Powered by Chrono",
}: {
  year: number;
  tenantName: string;
  tagline?: string | null;
  /** Honoured here — the reference stores this flag and ignores it. */
  hidePlatformBranding?: boolean;
  platformBrandingLabel?: string;
}) {
  return (
    <SiteFooter
      maxWidth="full"
      columns={[
        {
          heading: "Navigation",
          links: [
            { label: "Stations", href: "/stations" },
            { label: "About", href: "/about" },
            { label: "Sign in", href: "/portal/login" },
          ],
        },
        {
          heading: "Company",
          links: [
            { label: "Privacy Policy", href: "/privacy" },
            { label: "Terms of Service", href: "/terms" },
            { label: "Contact", href: "/contact" },
          ],
        },
      ]}
      brand={
        <Stack gap={2}>
          <span className="font-chrono text-lg font-black uppercase tracking-tight text-primary">
            {tenantName}
          </span>
          {tagline ? (
            <span className="max-w-sm text-muted-foreground">{tagline}</span>
          ) : null}
        </Stack>
      }
      bottomBar={
        <Row className="flex-col items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.3em] sm:flex-row">
          <span>
            © {year} {tenantName}
          </span>
          {hidePlatformBranding ? null : <span>{platformBrandingLabel}</span>}
        </Row>
      }
    />
  );
}
