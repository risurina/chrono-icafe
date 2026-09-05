import type { Metadata } from "next";
import Link from "next/link";
import { Users, Crosshair, Wrench, TrendingUp, Quote } from "lucide-react";
import {
  Section,
  Stack,
  Grid,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  buttonVariants,
  cn,
} from "agora/ui";

/**
 * IZUR-the-company's own "About" page — apex marketing copy, not a tenant's
 * landing "About" section (that's `(saas-landing)/about/page.tsx`, registry-
 * driven and tenant-scoped; this page is distinct from and untouched by it).
 *
 * Static Server Component: no data fetch, no tenant dependency — renders
 * identically on the apex or any tenant subdomain, like every other page
 * under the `(apex-marketing)` route group. Header/footer come from the
 * group's own `layout.tsx`.
 */

export const metadata: Metadata = {
  title: "About IZUR — Chrono",
  description:
    "Chrono is built by IZUR IT Solutions, a Philippines-based team building practical operations software for internet cafe owners.",
};

const CREDIBILITY_CARDS = [
  {
    title: "PH-based team",
    description:
      "Built by developers based in the Philippines, working from the same operational rhythms and constraints as the venues we build for.",
    icon: Users,
  },
  {
    title: "Real operations focus",
    description:
      "Every screen is shaped around a shift, a session, or a walk-in — not a generic dashboard bent into shape after the fact.",
    icon: Crosshair,
  },
  {
    title: "Implementation support",
    description:
      "We help set up branches, stations, staff roles, and starting balances so a new venue is live in days, not months.",
    icon: Wrench,
  },
  {
    title: "Built for growth",
    description:
      "One lounge or ten branches, the same reporting and visibility carries through as the business scales.",
    icon: TrendingUp,
  },
] as const;

export default function AboutIzurPage() {
  return (
    <>
      {/* pt clears the marketing header's fixed 80px bar — the same
          treatment as the apex landing hero (`(saas-landing)/page.tsx`),
          which shares this route group's fixed, transparent-until-scroll
          `MarketingHeader`. */}
      <Section maxWidth="full" className="pb-20 pt-32 lg:pb-28 lg:pt-40">
        <Stack gap={6} className="max-w-3xl">
          <Badge variant="secondary" className="w-fit uppercase tracking-widest">
            About IZUR
          </Badge>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Built by operators who understand the internet cafe floor.
          </h1>
          <p className="max-w-2xl text-balance text-lg text-muted-foreground">
            IZUR IT Solutions builds practical, no-nonsense software for
            operations-heavy businesses. Chrono is shaped around real
            internet cafe workflows — session tracking, staff accountability,
            and branch visibility — not a generic dashboard retrofitted to
            fit.
          </p>
          <Link
            href="/company/contact"
            className={cn(buttonVariants({ size: "lg" }), "w-fit rounded-full px-6")}
          >
            Talk to IZUR
          </Link>
        </Stack>
      </Section>

      <Section maxWidth="full" border="top" tone="muted" className="py-16">
        <Card className="mx-auto max-w-3xl">
          <CardContent className="flex gap-4 p-8">
            <Quote className="h-8 w-8 shrink-0 text-primary" aria-hidden />
            <p className="text-xl italic leading-relaxed text-muted-foreground">
              We built Chrono to give venue owners one command center for
              daily operations, staff accountability, and branch visibility —
              replacing the spreadsheets, group chats, and paper logs most
              venues still run on.
            </p>
          </CardContent>
        </Card>
      </Section>

      <Section maxWidth="full" className="py-16">
        <Grid cols={2} gap={4}>
          {CREDIBILITY_CARDS.map(({ title, description, icon: Icon }) => (
            <Card key={title}>
              <CardHeader>
                <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </Grid>
      </Section>
    </>
  );
}
