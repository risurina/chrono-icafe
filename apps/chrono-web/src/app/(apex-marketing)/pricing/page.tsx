import type { Metadata } from "next";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import {
  cn,
  buttonVariants,
  Section,
  Grid,
  Stack,
  Row,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  StatTile,
  SectionHeading,
  FaqItem,
} from "agora/ui";

/**
 * Static Pricing page — renders inside the `(apex-marketing)` route group's
 * shared shell (`layout.tsx`), which already supplies
 * `MarketingHeader`/`MarketingFooter`. This file is content only, no data
 * fetch: no public "read the plan catalog" endpoint exists yet (see
 * `.ai/plans/chrono/ready/apex-pricing-page/README.md`, "Data source"), and
 * oikos's own live pricing page is itself demo-gated with no real dollar
 * figures — static copy matches that shape exactly.
 *
 * Design reference (layout/UX only, never ported — per this repo's
 * "improve, don't port oikos" rule):
 * `~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/pricing/page.tsx`.
 *
 * Deviations from the reference, both deliberate:
 * - `Button` has no `asChild`/Slot support here, unlike oikos's — every CTA
 *   is a plain `Link` styled with `buttonVariants()`, matching this app's own
 *   existing convention (`marketing-chrome.tsx`, `(saas-landing)/page.tsx`).
 * - The reference's per-tier feature claims ("Audit trail visibility",
 *   "Advanced staff permissions") don't match what Chrono-on-Agora actually
 *   ships today (`apps/chrono-api/AGENTS.md`'s module status — reporting/
 *   audit-trail modules are deferred, not landed). Replaced with concrete,
 *   landed features (branch/station management, wallet & credits, staff
 *   shifts, reservations, tenant-defined custom roles via RBAC, member
 *   online payments) instead of carrying the unverified claims forward.
 */

export const metadata: Metadata = {
  title: "Pricing — Chrono",
  description: "Pricing that fits your venue size and rollout needs.",
};

/** Demo-gated pricing: every CTA goes to the same request-a-demo target. */
const CTA_HREF = "/support";

const PRICING_TIERS = [
  {
    name: "Starter Cafe",
    subtitle:
      "For single-branch venues getting station sessions and payments under control.",
    recommended: false,
    features: [
      "Branch & station management",
      "Wallet & credit balances",
      "Staff shift tracking",
      "Reservations & booking",
      "Standard rollout support",
    ],
  },
  {
    name: "Gaming Lounge",
    subtitle:
      "For premium lounges that need accountable staff shifts and a real owner dashboard.",
    recommended: true,
    features: [
      "Everything in Starter Cafe",
      "Member online payments (PayMongo)",
      "Custom staff roles (RBAC)",
      "Priority rollout support",
    ],
  },
  {
    name: "Multi-Branch",
    subtitle: "For operators running several branches from one account.",
    recommended: false,
    features: [
      "Everything in Gaming Lounge",
      "Centralized multi-branch dashboard",
      "Tenant-isolated data (RLS) at scale",
      "Custom onboarding & implementation support",
    ],
  },
] as const;

const ROLLOUT_HIGHLIGHTS = [
  "Branch & station tracking",
  "Wallet & credit balances",
  "Staff shift workflows",
  "Custom staff roles",
] as const;

const UPGRADE_TRIGGERS = [
  "You're opening a second branch and need one dashboard across every location.",
  "You need custom staff roles to manage a larger team beyond a single branch.",
  "You want dedicated onboarding support rolling Chrono out across multiple branches and their stations.",
] as const;

const PRICING_FAQS = [
  {
    q: "Why is pricing demo-based instead of listed here?",
    a: "Every venue is different — active stations, branch count, and rollout support all affect the final price. Request a private demo and we'll map a plan to your setup.",
  },
  {
    q: "Can I start with a single branch?",
    a: "Yes. Starter Cafe covers one branch, and you can move up to Gaming Lounge or Multi-Branch as you add locations — no separate signup or data migration needed.",
  },
  {
    q: "How does Multi-Branch pricing work?",
    a: "Multi-Branch pricing scales with the number of branches and stations you run, plus any custom onboarding you need — confirmed during your demo.",
  },
  {
    q: "Is my data isolated from other tenants on the platform?",
    a: "Yes. Every tenant's data is isolated with row-level security enforced at the database, not just filtered by the application, on every plan.",
  },
  {
    q: "What happens after I request a demo?",
    a: "Our team reviews your current setup, confirms which modules you need, and puts together a rollout plan and quote for your venue.",
  },
] as const;

export default function PricingPage() {
  return (
    <>
      <Section
        maxWidth="full"
        border="bottom"
        className="pb-20 pt-32 lg:pb-28 lg:pt-40"
      >
        <Grid cols={2} gap={4} className="items-center">
          <Stack gap={6}>
            <Badge variant="secondary" className="w-fit uppercase tracking-widest">
              Pricing
            </Badge>
            <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Pricing that fits your venue size and rollout needs.
            </h1>
            <p className="max-w-xl text-balance text-lg text-muted-foreground">
              Chrono pricing depends on active stations, branch count, and the
              rollout support you need. Start with the operational
              foundation, then expand as your venue grows.
            </p>
            <Row wrap gap={3} className="pt-2">
              <Link
                href={CTA_HREF}
                className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}
              >
                Request Private Demo
              </Link>
            </Row>
          </Stack>

          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <Row items="center" justify="between">
                <Row items="center" gap={2}>
                  <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                  <CardTitle className="text-sm">Rollout Paths</CardTitle>
                </Row>
                <Badge variant="secondary">Choose your pace</Badge>
              </Row>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <Grid cols={2} gap={3}>
                <StatTile label="Rollout support" value="Guided setup" />
                <StatTile label="Scalability" value="Multi-branch" />
              </Grid>
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="p-6">
                  <Stack gap={3}>
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">
                      What scales with you
                    </span>
                    <Stack gap={2}>
                      {ROLLOUT_HIGHLIGHTS.map((item) => (
                        <Row key={item} gap={2} items="center">
                          <Check
                            className="h-4 w-4 shrink-0 text-primary"
                            aria-hidden
                          />
                          <span className="text-sm text-muted-foreground">
                            {item}
                          </span>
                        </Row>
                      ))}
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            </CardContent>
          </Card>
        </Grid>
      </Section>

      <Section
        maxWidth="full"
        border="bottom"
        tone="muted"
        className="py-20"
      >
        <SectionHeading
          eyebrow="Plans"
          title="Three rollout paths, one platform."
          description="Every plan includes tenant-isolated data and row-level security. Request a private demo for a walkthrough mapped to your venue."
          className="mb-12 max-w-prose"
        />
        <Grid cols={3} gap={4}>
          {PRICING_TIERS.map((tier) => (
            <Card
              key={tier.name}
              className={cn(
                "flex flex-col",
                tier.recommended && "border-primary/40",
              )}
            >
              <CardHeader>
                <Row items="center" justify="between">
                  <CardTitle className="text-xl">{tier.name}</CardTitle>
                  {tier.recommended ? <Badge>Recommended</Badge> : null}
                </Row>
                <CardDescription>{tier.subtitle}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <Stack gap={2}>
                  {tier.features.map((feature) => (
                    <Row key={feature} gap={2} items="start">
                      <Check
                        className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                        aria-hidden
                      />
                      <span className="text-sm">{feature}</span>
                    </Row>
                  ))}
                </Stack>
              </CardContent>
              <CardFooter>
                <Link
                  href={CTA_HREF}
                  className={buttonVariants({
                    variant: tier.recommended ? "default" : "outline",
                    className: "w-full",
                  })}
                >
                  Request Private Demo
                </Link>
              </CardFooter>
            </Card>
          ))}
        </Grid>
        <p className="mt-8 text-center text-xs italic text-muted-foreground">
          Final pricing may depend on implementation scope, rollout support,
          tenant count, and required modules.
        </p>
      </Section>

      <Section maxWidth="full" className="py-20">
        <Grid cols={2} gap={4}>
          <Stack gap={4}>
            <SectionHeading
              eyebrow="Growing"
              title="When to upgrade to Multi-Branch"
            />
            <Stack gap={3}>
              {UPGRADE_TRIGGERS.map((trigger) => (
                <Row key={trigger} gap={3} items="start">
                  <span
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                  <span className="text-muted-foreground">{trigger}</span>
                </Row>
              ))}
            </Stack>
          </Stack>

          <Stack gap={4}>
            <SectionHeading eyebrow="FAQ" title="Pricing questions" />
            <Stack gap={0}>
              {PRICING_FAQS.map((faq) => (
                <FaqItem key={faq.q} question={faq.q}>
                  {faq.a}
                </FaqItem>
              ))}
            </Stack>
          </Stack>
        </Grid>
      </Section>
    </>
  );
}
