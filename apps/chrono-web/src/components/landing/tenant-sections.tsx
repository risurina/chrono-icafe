import Link from "next/link";
import { Mail, MapPin, Phone, Clock } from "lucide-react";
import {
  Section,
  Stack,
  Row,
  Grid,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  FaqItem,
  buttonVariants,
} from "agora/ui";
import { cn } from "agora/ui/cn";

/**
 * Chrono's tenant landing sections.
 *
 * Each takes one typed props object and composes only `agora/ui` primitives —
 * no raw `div`/`span`/`ul` chrome, which is the single biggest thing the
 * prior-art implementation does wrong (its footers are ~95% raw HTML inside
 * imported layout components).
 *
 * Every section carries a `data-testid` on its root so the e2e spec can assert
 * presence and absence when a tenant hides one.
 */

export type TenantHeroProps = {
  eyebrow: string | null;
  title: string;
  subtitle: string | null;
  primaryCta: { label: string; href: string } | null;
  secondaryCta: { label: string; href: string } | null;
};

export function TenantHero({
  eyebrow,
  title,
  subtitle,
  primaryCta,
  secondaryCta,
}: TenantHeroProps) {
  return (
    <Section
      maxWidth="full"
      border="bottom"
      className="relative overflow-hidden"
      data-testid="landing-section-hero"
    >
      {/* The dot field follows --primary, so a theme preset or the tenant's own
          brand colour retints it with no change here. */}
      <span
        aria-hidden
        className="premium-dots pointer-events-none absolute inset-0 -z-10 opacity-60"
      />
      <Stack gap={4} className="items-center py-24 text-center">
        {eyebrow ? <Badge variant="secondary">{eyebrow}</Badge> : null}
        <h1 className="premium-text-gradient max-w-3xl font-chrono text-heading-lg font-black uppercase tracking-tight">
          {title}
        </h1>
        {subtitle ? (
          <p className="max-w-2xl text-body-lg text-muted-foreground">{subtitle}</p>
        ) : null}
        <Row wrap className="justify-center">
          {primaryCta ? (
            <Link
              href={primaryCta.href}
              className={cn(buttonVariants(), "rounded-full px-6")}
              data-testid="landing-hero-primary-cta"
            >
              {primaryCta.label}
            </Link>
          ) : null}
          {secondaryCta ? (
            <Link
              href={secondaryCta.href}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "rounded-full px-6",
              )}
            >
              {secondaryCta.label}
            </Link>
          ) : null}
        </Row>
      </Stack>
    </Section>
  );
}

export type TenantAboutProps = { title: string; body: string | null };

export function TenantAbout({ title, body }: TenantAboutProps) {
  return (
    <Section maxWidth="full" tone="muted" data-testid="landing-section-about">
      <Stack gap={3} className="py-20">
        <h2 className="text-heading-md font-semibold tracking-tight">{title}</h2>
        {body ? (
          <p className="max-w-3xl whitespace-pre-line text-muted-foreground">
            {body}
          </p>
        ) : null}
      </Stack>
    </Section>
  );
}

export type TenantContactProps = {
  email: string | null;
  phone: string | null;
  address: string | null;
  operatingHours: string | null;
};

export function TenantContact({
  email,
  phone,
  address,
  operatingHours,
}: TenantContactProps) {
  const rows = [
    { icon: Mail, label: "Email", value: email },
    { icon: Phone, label: "Phone", value: phone },
    { icon: MapPin, label: "Address", value: address },
    { icon: Clock, label: "Hours", value: operatingHours },
  ].filter((r): r is typeof r & { value: string } => Boolean(r.value));

  if (rows.length === 0) return null;

  return (
    <Section maxWidth="full" data-testid="landing-section-contact">
      <Stack gap={4} className="py-20">
        <h2 className="text-heading-md font-semibold tracking-tight">
          Visit us
        </h2>
        <Grid cols={2} gap={4}>
          {rows.map(({ icon: Icon, label, value }) => (
            <Card key={label} className="premium-card-shadow">
              <CardHeader>
                <Row className="items-center gap-2 text-muted-foreground">
                  <Icon className="h-4 w-4 text-primary" aria-hidden />
                  <CardDescription>{label}</CardDescription>
                </Row>
                <CardTitle className="text-base">{value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}

export type TenantFaqProps = { faqs: { question: string; answer: string }[] };

export function TenantFaq({ faqs }: TenantFaqProps) {
  if (faqs.length === 0) return null;
  return (
    <Section maxWidth="full" tone="muted" data-testid="landing-section-faq">
      <Stack gap={4} className="py-20">
        <h2 className="text-heading-md font-semibold tracking-tight">
          Frequently asked
        </h2>
        <Stack gap={2} className="max-w-3xl">
          {faqs.map((faq) => (
            <FaqItem key={faq.question} question={faq.question}>
              {faq.answer}
            </FaqItem>
          ))}
        </Stack>
      </Stack>
    </Section>
  );
}

export type TenantCtaProps = {
  tenantName: string;
  cta: { label: string; href: string } | null;
};

export function TenantCta({ tenantName, cta }: TenantCtaProps) {
  return (
    <Section maxWidth="full" border="top" data-testid="landing-section-cta">
      <Stack gap={4} className="items-center py-20 text-center">
        <h2 className="text-heading-md font-semibold tracking-tight">
          Ready to visit {tenantName}?
        </h2>
        <Row wrap className="justify-center">
          <Link
            href={cta?.href ?? "/stations"}
            className={cn(buttonVariants(), "rounded-full px-6")}
          >
            {cta?.label ?? "See live availability"}
          </Link>
          <Link
            href="/portal/login"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "rounded-full px-6",
            )}
          >
            Member sign in
          </Link>
        </Row>
      </Stack>
    </Section>
  );
}
