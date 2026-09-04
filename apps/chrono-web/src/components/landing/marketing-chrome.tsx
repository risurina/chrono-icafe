import Link from "next/link";
import { Globe, Mail, MapPin, Phone } from "lucide-react";
import {
  SiteHeader,
  SiteFooter,
  ThemeToggle,
  BrandHeader,
  Stack,
  Row,
  buttonVariants,
  type FooterColumn,
} from "agora/ui";
import { cn } from "agora/ui/cn";
import { ChronoBrand } from "./chrono-brand";

/**
 * Chrono's marketing and tenant chrome, matching the karta-oikos/chrono design.
 *
 * One header and one footer, composed from the foundation primitives — the
 * reference ships three near-identical copies of each with no shared code, and
 * the tenant variants below take props rather than duplicating the markup.
 *
 * The header is `fixed` (80px tall), not sticky, so the hero's background
 * bleeds up behind the transparent bar instead of stopping below it. The
 * trade-off: the first section must add its own ~80px of top padding to its
 * *content* so nothing renders under the header.
 */

/** Shared metrics so the SaaS and tenant headers can't drift apart. */
const HEADER_PROPS = {
  maxWidth: "full",
  position: "fixed",
  transparentUntilScroll: true,
  // h-12 mark + py-4 = the reference's 80px bar.
  containerClassName: "h-20",
  navClassName: "gap-8",
} as const;

const NAV_LINK = "font-medium transition-colors hover:text-foreground";

/** The gold pill: semantic `bg-primary` + a primary-tinted glow. */
const CTA_PILL =
  "h-10 rounded-full px-6 text-[10px] font-bold uppercase tracking-widest shadow-lg shadow-primary/20";

const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/#pricing" },
  { label: "About", href: "/about" },
  { label: "Support", href: "/contact" },
  { label: "Login", href: "/login" },
];

export function MarketingHeader() {
  return (
    <SiteHeader
      {...HEADER_PROPS}
      brand={
        <Link href="/" aria-label="Chrono home">
          <ChronoBrand />
        </Link>
      }
      nav={NAV.map((item) => (
        <Link key={item.href} href={item.href} className={NAV_LINK}>
          {item.label}
        </Link>
      ))}
      mobileNav={
        <>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="px-2 py-2">
              {item.label}
            </Link>
          ))}
        </>
      }
      actions={
        <>
          <ThemeToggle />
          <Link
            href="/contact"
            className={cn(buttonVariants(), CTA_PILL)}
            data-testid="marketing-cta"
          >
            Request Private Demo
          </Link>
        </>
      }
    />
  );
}

/** Mirrors the reference tenant nav: section anchors, not separate pages. */
const TENANT_NAV = [
  { label: "Home", href: "/" },
  { label: "Rates", href: "/#rates" },
  { label: "Specs", href: "/#specs" },
  { label: "Games", href: "/#games" },
  { label: "Stations", href: "/#stations" },
  { label: "Location", href: "/#location" },
];

/**
 * The tenant-branded header. Same shell and metrics as `MarketingHeader` — the
 * only differences are the brand lockup (the tenant's logo/name, never Chrono's
 * owl) and that the CTA signs a customer in rather than booking a demo.
 */
export function TenantHeader({
  tenantName,
  displayName,
  logoUrl,
  logoDarkUrl,
}: {
  tenantName: string;
  displayName?: string | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
}) {
  return (
    <SiteHeader
      {...HEADER_PROPS}
      brand={
        <Link href="/" aria-label={`${displayName ?? tenantName} home`}>
          {logoUrl || logoDarkUrl ? (
            <BrandHeader
              compact
              displayName={displayName}
              logoUrl={logoUrl}
              logoDarkUrl={logoDarkUrl}
              fallback={tenantName}
            />
          ) : (
            // No logo uploaded → the tenant's name as a wordmark in the brand
            // face, matching the SaaS lockup's weight. `BrandHeader`'s text
            // fallback is small body copy, which reads as a stray label in an
            // 80px marketing bar.
            <span className="font-chrono text-xl font-black uppercase tracking-tight text-primary lg:text-2xl">
              {displayName ?? tenantName}
            </span>
          )}
        </Link>
      }
      nav={TENANT_NAV.map((item) => (
        <Link key={item.href} href={item.href} className={NAV_LINK}>
          {item.label}
        </Link>
      ))}
      mobileNav={
        <>
          {TENANT_NAV.map((item) => (
            <Link key={item.href} href={item.href} className="px-2 py-2">
              {item.label}
            </Link>
          ))}
          <Link href="/login" className="px-2 py-2">
            Staff sign in
          </Link>
        </>
      }
      actions={
        <>
          <ThemeToggle />
          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "hidden text-xs font-bold uppercase tracking-widest md:inline-flex",
            )}
          >
            Staff
          </Link>
          <Link
            href="/portal/login"
            className={cn(buttonVariants(), CTA_PILL)}
            data-testid="tenant-cta"
          >
            Member login
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
      { label: "About IZUR", href: "/about" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

const SOCIAL_LINKS = [
  { href: "/contact", label: "Email Chrono", Icon: Mail },
  { href: "/contact", label: "Call Chrono", Icon: Phone },
  { href: "/about", label: "About Chrono", Icon: Globe },
];

/** The pulsing "live" dot — `chart-2` is the palette's emerald. */
function LiveDot() {
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-chart-2"
    />
  );
}

const SOCIAL_CIRCLE =
  "flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/30 text-primary/60 transition-all hover:bg-muted/60 hover:text-primary";

const BOTTOM_BAR =
  "flex-col items-center justify-between gap-6 text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40 md:flex-row";

export function MarketingFooter({ year }: { year: number }) {
  return (
    <SiteFooter
      maxWidth="full"
      // The brand blurb sits *beside* the link columns, as the reference's
      // four-column grid does, rather than on its own row underneath.
      layout="brand-column"
      tone="marketing"
      columns={[
        ...FOOTER_COLUMNS,
        {
          heading: "Location",
          content: (
            <Stack gap={4}>
              <Row gap={3} className="items-start">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="text-sm font-bold tracking-tight text-muted-foreground">
                  City Of SJDM, Bulacan
                  <br />
                  Philippines
                </span>
              </Row>
              <Row gap={3} items="center">
                <LiveDot />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
                  Operations Live
                </span>
              </Row>
            </Stack>
          ),
        },
      ]}
      brand={
        <>
          {/* Flat primary, not the gradient — matches the reference footer. */}
          <ChronoBrand gradient={false} />
          <span className="max-w-sm text-sm font-medium leading-relaxed text-muted-foreground">
            A premium internet cafe management platform for station sessions,
            wallets, and branch operations. Built by IZUR IT Solutions.
          </span>
          <Row gap={4}>
            {SOCIAL_LINKS.map(({ href, label, Icon }) => (
              <Link key={label} href={href} aria-label={label} className={SOCIAL_CIRCLE}>
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </Link>
            ))}
          </Row>
        </>
      }
      bottomBar={
        <Row className={BOTTOM_BAR}>
          <span>© {year} IZUR IT Solutions. All rights reserved.</span>
          <Row gap={0} className="gap-8">
            <span>Designed in PH</span>
            <span>Powered by IZUR</span>
          </Row>
        </Row>
      }
    />
  );
}

/**
 * The tenant-branded footer variant — the same shell, layout and `marketing`
 * tone as `MarketingFooter`, so the two surfaces read as one design. The
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
      layout="brand-column"
      tone="marketing"
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
        {
          heading: "Hours",
          content: (
            <Row gap={3} items="center">
              <LiveDot />
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
                Open Now
              </span>
            </Row>
          ),
        },
      ]}
      brand={
        <>
          <span className="font-chrono text-2xl font-black uppercase tracking-tighter text-primary">
            {tenantName}
          </span>
          {tagline ? (
            <span className="max-w-sm text-sm font-medium leading-relaxed text-muted-foreground">
              {tagline}
            </span>
          ) : null}
        </>
      }
      bottomBar={
        <Row className={BOTTOM_BAR}>
          <span>
            © {year} {tenantName}
          </span>
          {hidePlatformBranding ? null : <span>{platformBrandingLabel}</span>}
        </Row>
      }
    />
  );
}
