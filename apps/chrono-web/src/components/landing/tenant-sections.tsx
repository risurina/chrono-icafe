import type * as React from "react";
import Link from "next/link";
import {
  Mail,
  MapPin,
  Phone,
  Clock,
  Cpu,
  Zap,
  Monitor,
  HardDrive,
  MousePointer2,
  Wifi,
  Armchair,
  Check,
  Quote,
  Trophy,
  Sparkles,
  Users,
} from "lucide-react";
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
import { StationRefresh } from "./station-refresh";

/**
 * Chrono's tenant landing sections.
 *
 * Each takes one typed props object and composes only `agora/ui` primitives —
 * no raw `div`/`span`/`ul` chrome, which is the single biggest thing the
 * prior-art implementation does wrong (its footers are ~95% raw HTML inside
 * imported layout components).
 *
 * Every section carries a `data-testid` on its root so the e2e spec can assert
 * presence and absence when a tenant hides one. Colours are semantic tokens
 * throughout — the reference hardcodes `#E5A93C` / `#A1A1AA` / `#000000`
 * literals in every file, which is why its own theme system never reaches the
 * tenant page.
 */

type Cta = { label: string; href: string } | null;

/* ───────────────────────────── shared bits ───────────────────────────── */

/**
 * `Stack` is a `space-y-*` **block** box, so bare inline `span`s inside it flow
 * side by side instead of stacking (`space-y` only sets margins between block
 * siblings). Nearly every label/value pair below is exactly that shape, so this
 * is the flex-column form — use it whenever the children are inline.
 */
function Col({
  children,
  gap = 2,
  className,
}: {
  children: React.ReactNode;
  gap?: React.ComponentProps<typeof Stack>["gap"];
  className?: string;
}) {
  return (
    <Stack gap={gap} className={cn("flex flex-col", className)}>
      {children}
    </Stack>
  );
}

const EYEBROW = "text-[10px] font-black uppercase tracking-[0.3em] text-primary";
const TITLE =
  "text-4xl font-black uppercase tracking-widest md:text-5xl text-balance";
const LEAD =
  "text-sm font-bold uppercase tracking-widest text-muted-foreground text-balance";
const LABEL = "text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground";
const PILL_CTA =
  "h-12 rounded-full px-8 text-xs font-black uppercase tracking-widest";
const PANEL =
  "rounded-2xl border border-border bg-card/40 p-6 transition-colors hover:border-primary/40";

/** Eyebrow + big uppercase title + optional lead. */
function SectionIntro({
  eyebrow,
  title,
  lead,
  align = "center",
}: {
  eyebrow?: string | null;
  title: string;
  lead?: string | null;
  align?: "left" | "center";
}) {
  return (
    <Stack
      gap={4}
      className={cn(
        "mb-16 flex flex-col",
        align === "center" ? "mx-auto max-w-2xl items-center text-center" : "items-start",
      )}
    >
      {eyebrow ? <span className={EYEBROW}>{eyebrow}</span> : null}
      <h2 className={TITLE}>{title}</h2>
      {lead ? <p className={LEAD}>{lead}</p> : null}
    </Stack>
  );
}

/** A metric tile with a proportional bar — the hero bento's building block. */
function GaugeTile({
  label,
  value,
  suffix,
  caption,
  ratio,
  icon: Icon,
  accent = "primary",
}: {
  label: string;
  value: number;
  suffix: string;
  caption: string;
  ratio: number;
  icon: typeof Monitor;
  accent?: "primary" | "live";
}) {
  return (
    <Stack gap={0} className={cn(PANEL, "flex flex-col justify-between")}>
      <Row justify="between" items="center" className="mb-8">
        <span className={LABEL}>{label}</span>
        <Icon className="h-4 w-4 text-primary" aria-hidden />
      </Row>
      <Col gap={2}>
        <Row items="end" gap={2}>
          <span className="text-4xl font-black leading-none">{value}</span>
          <span className="pb-1 text-sm font-bold text-muted-foreground">{suffix}</span>
        </Row>
        <span className="text-xs font-bold uppercase tracking-widest">{caption}</span>
        <span className="block h-1 w-full overflow-hidden rounded-full bg-border">
          <span
            className={cn(
              "block h-full transition-all duration-1000",
              accent === "live" ? "bg-chart-2" : "bg-primary",
            )}
            style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
          />
        </span>
      </Col>
    </Stack>
  );
}

/* ─────────────────────────────── hero ────────────────────────────────── */

export type TenantHeroProps = {
  eyebrow: string | null;
  title: string;
  subtitle: string | null;
  primaryCta: Cta;
  secondaryCta: Cta;
  /** Live floor summary. Absent → the bento renders a neutral placeholder. */
  summary?: { available: number; inUse: number; total: number } | null;
  branchName?: string | null;
  specLines?: readonly string[];
  gameTags?: readonly string[];
};

export function TenantHero({
  eyebrow,
  title,
  subtitle,
  primaryCta,
  secondaryCta,
  summary = null,
  branchName,
  specLines = [],
  gameTags = [],
}: TenantHeroProps) {
  const total = summary?.total ?? 0;
  const inUse = summary?.inUse ?? 0;
  const available = summary?.available ?? 0;

  return (
    <Section
      maxWidth="full"
      border="bottom"
      className="premium-dots relative overflow-hidden"
      data-testid="landing-section-hero"
    >
      {/* pt clears the 80px fixed header; the background bleeds up behind it. */}
      <Grid cols={2} gap={4} className="items-center pb-24 pt-40 lg:gap-16">
        <Stack gap={8} className="flex flex-col items-start text-left">
          {eyebrow ? (
            <Row
              items="center"
              gap={3}
              className="w-fit rounded-full border border-primary/20 bg-primary/10 px-5 py-2"
            >
              <Zap className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span className="text-[10px] font-black uppercase tracking-[0.2em]">
                {eyebrow}
              </span>
            </Row>
          ) : null}

          <Stack gap={6}>
            <h1
              className={cn(
                "font-chrono text-4xl font-black uppercase leading-[1.05] tracking-widest lg:text-6xl",
                "premium-text-gradient text-balance",
              )}
            >
              {title}
            </h1>
            {subtitle ? (
              <p className="max-w-lg text-lg font-medium leading-relaxed text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
            {specLines.length > 0 ? (
              <Stack gap={2}>
                {specLines.map((line) => (
                  <Row key={line} items="center" gap={2}>
                    <Monitor className="h-3 w-3 shrink-0 text-primary" aria-hidden />
                    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      {line}
                    </span>
                  </Row>
                ))}
              </Stack>
            ) : null}
          </Stack>

          <Row wrap gap={4}>
            {primaryCta ? (
              <Link
                href={primaryCta.href}
                className={cn(buttonVariants(), PILL_CTA, "shadow-lg shadow-primary/20")}
                data-testid="landing-hero-primary-cta"
              >
                {primaryCta.label}
              </Link>
            ) : null}
            {secondaryCta ? (
              <Link
                href={secondaryCta.href}
                className={cn(buttonVariants({ variant: "outline" }), PILL_CTA)}
              >
                {secondaryCta.label}
              </Link>
            ) : null}
          </Row>

          {gameTags.length > 0 ? (
            <Row wrap gap={4} className="pt-2 opacity-60">
              {gameTags.map((game) => (
                <span
                  key={game}
                  className="text-[9px] font-black uppercase tracking-widest"
                >
                  {game}
                </span>
              ))}
            </Row>
          ) : null}
        </Stack>

        {/* Live floor bento */}
        <Grid cols={2} gap={4}>
          <Row
            justify="between"
            items="center"
            className={cn(PANEL, "col-span-2")}
          >
            <Col gap={1}>
              <span className={LABEL}>Status report</span>
              <span className="text-2xl font-black uppercase tracking-widest">
                {branchName ?? "Main floor"}
              </span>
            </Col>
            <Row
              items="center"
              gap={2}
              className="shrink-0 rounded-full border border-border px-3 py-1.5"
            >
              <span
                aria-hidden
                className="h-2 w-2 animate-pulse rounded-full bg-chart-2"
              />
              <span className="text-[10px] font-bold uppercase tracking-widest text-chart-2">
                Live
              </span>
            </Row>
          </Row>

          <GaugeTile
            label="Occupancy"
            value={inUse}
            suffix={`/ ${total}`}
            caption="In session"
            ratio={total ? inUse / total : 0}
            icon={Monitor}
          />
          <GaugeTile
            label="Available"
            value={available}
            suffix="open"
            caption="Ready now"
            ratio={total ? available / total : 0}
            icon={Users}
            accent="live"
          />

          <Grid cols={2} gap={4} className={cn(PANEL, "col-span-2")}>
            <Col gap={2}>
              <span className={LABEL}>Walk-ins</span>
              <span className="text-xl font-black">
                {available > 0 ? "Ready" : "Full"}
              </span>
            </Col>
            <Col gap={2}>
              <span className={LABEL}>Stations</span>
              <span className="text-xl font-black">{total || "—"}</span>
            </Col>
          </Grid>
        </Grid>
      </Grid>
    </Section>
  );
}

/* ─────────────────────────────── rates ───────────────────────────────── */

export type Rate = {
  title: string;
  price: string;
  period: string;
  features: readonly string[];
  isPopular?: boolean;
};

const DEFAULT_RATES: readonly Rate[] = [
  {
    title: "Regular rate",
    price: "₱30",
    period: "/ hr",
    features: ["Walk-in friendly", "Standard station access", "Smooth gameplay"],
  },
  {
    title: "Member rate",
    price: "₱25",
    period: "/ hr",
    features: [
      "Discounted hourly rate",
      "Priority access when available",
      "Best for regular players",
    ],
    isPopular: true,
  },
  {
    title: "Promo rate",
    price: "₱100",
    period: "/ 5 hrs",
    features: [
      "Long-session value",
      "Great for group play",
      "Limited-time availability",
    ],
  },
];

export type TenantRatesProps = { rates?: readonly Rate[]; cta?: Cta };

export function TenantRates({ rates = DEFAULT_RATES, cta }: TenantRatesProps) {
  if (rates.length === 0) return null;

  return (
    <Section
      id="rates"
      maxWidth="full"
      border="bottom"
      data-testid="landing-section-rates"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro
          align="left"
          eyebrow="Check your play time before you visit"
          title="Simple gaming rates"
        />
        <Grid cols={3} gap={4}>
          {rates.map((rate) => (
            <Stack
              key={rate.title}
              gap={0}
              className={cn(
                "relative flex flex-col overflow-hidden rounded-2xl border bg-card/40 p-8 transition-all",
                rate.isPopular
                  ? "z-10 border-primary/50 premium-card-shadow hover:border-primary"
                  : "border-border hover:border-primary/40",
              )}
              data-testid={`landing-rate-${rate.title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {rate.isPopular ? (
                <Badge className="absolute right-0 top-0 rounded-none rounded-bl-lg px-4 py-1.5 text-[10px] font-black uppercase tracking-widest">
                  Best value
                </Badge>
              ) : null}

              <Col gap={4} className="mb-8 border-b border-border pb-8">
                <span className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
                  {rate.title}
                </span>
                <Row items="end" gap={2}>
                  <span className="text-5xl font-black tracking-tighter">
                    {rate.price}
                  </span>
                  <span className="pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {rate.period}
                  </span>
                </Row>
              </Col>

              <Stack gap={4} className="mb-8 flex-1">
                <span className={LABEL}>Includes</span>
                {rate.features.map((feature) => (
                  <Row key={feature} items="center" gap={3}>
                    <Check
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      strokeWidth={3}
                      aria-hidden
                    />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {feature}
                    </span>
                  </Row>
                ))}
              </Stack>

              <Link
                href={cta?.href ?? "/stations"}
                className={cn(
                  buttonVariants({ variant: rate.isPopular ? "default" : "outline" }),
                  "mt-auto h-12 w-full text-xs font-black uppercase tracking-widest",
                )}
              >
                {cta?.label ?? "Start playing"}
              </Link>
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}

/* ─────────────────────────── station specs ───────────────────────────── */

export type StationSpecs = {
  cpu?: string | null;
  gpu?: string | null;
  monitor?: string | null;
  ram?: string | null;
  peripherals?: string | null;
  network?: string | null;
  comfort?: string | null;
};

export type TenantSpecsProps = { specs?: StationSpecs };

export function TenantSpecs({ specs = {} }: TenantSpecsProps) {
  const items = [
    { label: "Processor", value: specs.cpu, icon: Cpu, span: "lg:col-span-4" },
    { label: "Graphics", value: specs.gpu, icon: Zap, span: "lg:col-span-4" },
    { label: "Display", value: specs.monitor, icon: Monitor, span: "lg:col-span-4" },
    { label: "Memory", value: specs.ram, icon: HardDrive, span: "lg:col-span-3" },
    {
      label: "Peripherals",
      value: specs.peripherals,
      icon: MousePointer2,
      span: "lg:col-span-3",
    },
    { label: "Network", value: specs.network, icon: Wifi, span: "lg:col-span-3" },
    { label: "Comfort", value: specs.comfort, icon: Armchair, span: "lg:col-span-3" },
  ].filter((item): item is typeof item & { value: string } => Boolean(item.value));

  // Nothing configured → no section, rather than a grid of empty cards.
  if (items.length === 0) return null;

  return (
    <Section
      id="specs"
      maxWidth="full"
      border="bottom"
      tone="muted"
      data-testid="landing-section-specs"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro
          eyebrow="Performance-ready specs for smooth gameplay"
          title="What's inside every station"
        />
        {/* 12 columns so a spec can claim a third or a quarter of a row; the
            Grid primitive tops out at 4, so this sets the template directly. */}
        <Grid cols={4} gap={4} className="lg:grid-cols-12">
          {items.map(({ label, value, icon: Icon, span }) => (
            <Stack
              key={label}
              gap={4}
              className={cn(PANEL, "col-span-2 lg:col-span-6", span)}
              data-testid={`landing-spec-${label.toLowerCase()}`}
            >
              <Row items="center" gap={4}>
                <Row
                  items="center"
                  justify="center"
                  className="h-10 w-10 shrink-0 rounded-xl bg-primary/10"
                >
                  <Zap className="hidden" aria-hidden />
                  <Icon className="h-4.5 w-4.5 text-primary" aria-hidden />
                </Row>
                <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  {label}
                </span>
              </Row>
              <span className="text-xl font-black tracking-tight">{value}</span>
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}

/* ─────────────────────────────── games ───────────────────────────────── */

export type TenantGamesProps = { games?: readonly string[] };

export function TenantGames({ games = [] }: TenantGamesProps) {
  if (games.length === 0) return null;

  return (
    <Section
      id="games"
      maxWidth="full"
      border="bottom"
      data-testid="landing-section-games"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro
          eyebrow="Popular titles ready for casual and competitive players"
          title="Play your favourite games"
        />
        <Row wrap gap={4} justify="center">
          {games.map((game) => (
            <Stack
              key={game}
              gap={2}
              className={cn(
                PANEL,
                "min-w-[140px] items-center px-6 py-4 text-center hover:bg-primary/5",
              )}
            >
              <span className="text-sm font-black uppercase tracking-widest">
                {game}
              </span>
            </Stack>
          ))}
        </Row>
      </Stack>
    </Section>
  );
}

/* ──────────────────────────── testimonials ───────────────────────────── */

export type Testimonial = { text: string; author: string; rank?: string | null };

export type TenantTestimonialsProps = {
  testimonials?: readonly Testimonial[];
  badges?: readonly string[];
};

const BADGE_ICONS = [Zap, Sparkles, Users, Monitor];

export function TenantTestimonials({
  testimonials = [],
  badges = [],
}: TenantTestimonialsProps) {
  if (testimonials.length === 0 && badges.length === 0) return null;

  return (
    <Section
      maxWidth="full"
      border="bottom"
      tone="muted"
      data-testid="landing-section-testimonials"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro eyebrow="Player feedback" title="Trusted by local gamers" />
        {testimonials.length > 0 ? (
          <Grid cols={3} gap={4} className="mb-16">
            {testimonials.map((review) => (
              <Stack key={review.author} gap={8} className={cn(PANEL, "relative")}>
                <Quote
                  className="absolute right-6 top-6 h-6 w-6 text-primary/20"
                  aria-hidden
                />
                <p className="text-lg font-medium italic leading-relaxed">
                  &ldquo;{review.text}&rdquo;
                </p>
                <Col gap={1} className="mt-auto">
                  <span className="text-sm font-black uppercase tracking-widest">
                    {review.author}
                  </span>
                  {review.rank ? (
                    <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                      {review.rank}
                    </span>
                  ) : null}
                </Col>
              </Stack>
            ))}
          </Grid>
        ) : null}
        {badges.length > 0 ? (
          <Row wrap gap={4} justify="center" className="border-t border-border pt-12">
            {badges.map((badge, i) => {
              const Icon = BADGE_ICONS[i % BADGE_ICONS.length] ?? Zap;
              return (
                <Row
                  key={badge}
                  items="center"
                  gap={2}
                  className="rounded-full border border-border px-4 py-2"
                >
                  <Icon className="h-3.5 w-3.5 text-primary" aria-hidden />
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    {badge}
                  </span>
                </Row>
              );
            })}
          </Row>
        ) : null}
      </Stack>
    </Section>
  );
}

/* ───────────────────────────── station matrix ────────────────────────── */

/**
 * Semantic tone per station status — no raw colour literals.
 *
 * Keyed to the API's `stationStatusSchema`, which today is exactly these three.
 * A status the server adds later renders through the `offline` fallback below
 * rather than crashing on a missing key.
 */
const STATION_TONE = {
  available: { dot: "bg-chart-2", text: "text-chart-2", label: "Available" },
  maintenance: { dot: "bg-chart-4", text: "text-chart-4", label: "Maintenance" },
  offline: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "Offline" },
} as const;

export type StationStatus = keyof typeof STATION_TONE;

export type TenantStationsProps = {
  branches: readonly {
    id: string;
    name: string;
    code: string;
    stations: readonly {
      id: string;
      name: string;
      status: StationStatus;
    }[];
  }[];
  aggregate: { total: number; available: number; inUse: number } | null;
  isOpen?: boolean;
};

/**
 * The live floor grid. Server-rendered off `/public/stations`, which is itself
 * cached for 10s — a client-side poller would add a socket per visitor for data
 * that changes on the order of minutes.
 */
export function TenantStations({
  branches,
  aggregate,
  isOpen = true,
}: TenantStationsProps) {
  const stations = branches.flatMap((b) => b.stations);
  if (stations.length === 0) return null;

  const counts = {
    available: stations.filter((s) => s.status === "available").length,
    maintenance: stations.filter((s) => s.status === "maintenance").length,
    offline: stations.filter((s) => s.status === "offline").length,
    // "In session" is not a station status — the API derives occupancy in its
    // aggregate, so read it there rather than recomputing it wrongly here.
    inUse: aggregate?.inUse ?? 0,
  };

  return (
    <Section
      id="stations"
      maxWidth="full"
      border="bottom"
      data-testid="landing-section-stations"
    >
      <Stack gap={0} className="py-24">
        <Row
          justify="between"
          items="center"
          className="mb-12 flex-col gap-6 md:flex-row"
        >
          <Col gap={4}>
            <span className={EYEBROW}>Live monitor</span>
            <h2 className={TITLE}>Station matrix</h2>
          </Col>
          <StationRefresh
            totalLabel={`${aggregate?.total ?? stations.length} stations`}
          />
        </Row>

        <Grid cols={4} gap={4} className="items-start">
          {/* Network status rail */}
          <Col gap={4} className={cn(PANEL, "lg:col-span-1")}>
            <Row items="center" gap={2}>
              <Zap className="h-4 w-4 text-primary" aria-hidden />
              <span className="text-xs font-black uppercase tracking-widest">
                Network status
              </span>
            </Row>

            <Row
              justify="between"
              items="center"
              className="rounded-xl border border-chart-2/30 bg-chart-2/5 px-4 py-3"
            >
              <span className={LABEL}>Lounge status</span>
              <span className="text-xs font-black uppercase tracking-widest text-chart-2">
                {isOpen ? "Open" : "Closed"}
              </span>
            </Row>

            {(
              [
                ["available", "Stations available", "available"],
                ["inUse", "Players online", "offline"],
                ["maintenance", "Maintenance", "maintenance"],
                ["offline", "Offline", "offline"],
              ] as const
            ).map(([key, label, tone]) => (
              <Row
                key={key}
                justify="between"
                items="center"
                className="rounded-xl border border-border px-4 py-3"
              >
                <Row items="center" gap={3}>
                  <span
                    aria-hidden
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      STATION_TONE[tone].dot,
                    )}
                  />
                  <span className={LABEL}>{label}</span>
                </Row>
                <span className="text-sm font-black">{counts[key]}</span>
              </Row>
            ))}
          </Col>

          {/* Station grid, one block per branch */}
          <Stack gap={8} className={cn(PANEL, "col-span-4 lg:col-span-3")}>
            {branches
              .filter((branch) => branch.stations.length > 0)
              .map((branch) => (
                <Col key={branch.id} gap={4}>
                  {branches.length > 1 ? (
                    <span className={LABEL}>{branch.name}</span>
                  ) : null}
                  <Row wrap gap={4}>
                    {branch.stations.map((station) => {
                      const tone =
                        STATION_TONE[station.status as StationStatus] ??
                        STATION_TONE.offline;
                      return (
                        <Col
                          key={station.id}
                          gap={2}
                          className="w-[140px] rounded-xl border border-border p-3 transition-colors hover:border-primary/40"
                          data-testid={`landing-station-${station.name}`}
                        >
                          <Col
                            gap={2}
                            className="rounded-lg bg-primary/5 p-4"
                          >
                            <Row items="center" gap={2}>
                              <span
                                aria-hidden
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  tone.dot,
                                )}
                              />
                              <span
                                className={cn(
                                  "text-[9px] font-black uppercase tracking-widest",
                                  tone.text,
                                )}
                              >
                                {tone.label}
                              </span>
                            </Row>
                            <Monitor
                              className="mx-auto h-6 w-6 text-primary"
                              aria-hidden
                            />
                          </Col>
                          <span className="text-xs font-black uppercase tracking-widest">
                            {station.name}
                          </span>
                        </Col>
                      );
                    })}
                  </Row>
                </Col>
              ))}
          </Stack>
        </Grid>
      </Stack>
    </Section>
  );
}

/* ─────────────────────────────── events ──────────────────────────────── */

export type TenantEventsProps = { followHref?: string | null };

export function TenantEvents({ followHref }: TenantEventsProps) {
  return (
    <Section
      id="events"
      maxWidth="full"
      border="bottom"
      data-testid="landing-section-events"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro
          eyebrow="Events & tournaments"
          title="Prove your skill"
          lead="Compete for prizes and glory in our regular tournaments."
        />
        <Stack
          gap={6}
          className="mx-auto max-w-xl items-center rounded-2xl border border-dashed border-border p-12 text-center"
        >
          <Trophy className="h-8 w-8 text-primary/50" aria-hidden />
          <h3 className="text-2xl font-black uppercase tracking-widest">
            No tournament posted yet
          </h3>
          <p className="text-sm font-bold leading-relaxed text-muted-foreground">
            Check back for upcoming match nights and community gaming events.
          </p>
          {followHref ? (
            <Link
              href={followHref}
              className={cn(buttonVariants(), PILL_CTA)}
            >
              Follow for updates
            </Link>
          ) : null}
        </Stack>
      </Stack>
    </Section>
  );
}

/* ─────────────────────────────── about ───────────────────────────────── */

export type TenantAboutProps = { title: string; body: string | null };

export function TenantAbout({ title, body }: TenantAboutProps) {
  if (!body) return null;
  return (
    <Section
      maxWidth="full"
      border="bottom"
      tone="muted"
      data-testid="landing-section-about"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro align="left" eyebrow="Who we are" title={title} />
        <p className="max-w-3xl whitespace-pre-line text-lg leading-relaxed text-muted-foreground">
          {body}
        </p>
      </Stack>
    </Section>
  );
}

/* ────────────────────────── contact / location ───────────────────────── */

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
    { icon: MapPin, label: "Address", value: address },
    { icon: Clock, label: "Business hours", value: operatingHours },
    { icon: Phone, label: "Phone", value: phone, href: phone ? `tel:${phone}` : null },
    { icon: Mail, label: "Email", value: email, href: email ? `mailto:${email}` : null },
  ].filter((r): r is typeof r & { value: string } => Boolean(r.value));

  if (rows.length === 0) return null;

  // The map is derived from the tenant's own address — no extra field to
  // configure, and no API key: Google's `output=embed` search URL needs neither.
  const mapsQuery = address ? encodeURIComponent(address) : null;

  return (
    <Section
      id="location"
      maxWidth="full"
      border="bottom"
      data-testid="landing-section-contact"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro align="left" eyebrow="Location & contact" title="Find us" />
        <Grid cols={2} gap={4} className="items-start lg:gap-16">
          <Grid cols={2} gap={4}>
            {rows.map(({ icon: Icon, label, value, href }) => (
              <Card key={label} className={PANEL}>
                <CardHeader className="gap-4 p-0">
                  <Row items="center" gap={3}>
                    <Row
                      items="center"
                      justify="center"
                      className="h-8 w-8 shrink-0 rounded-lg border border-border"
                    >
                      <Icon className="h-4 w-4 text-primary" aria-hidden />
                    </Row>
                    <CardDescription className={LABEL}>{label}</CardDescription>
                  </Row>
                  <CardTitle className="text-sm font-bold leading-relaxed">
                    {href ? (
                      <Link href={href} className="text-primary hover:underline">
                        {value}
                      </Link>
                    ) : (
                      value
                    )}
                  </CardTitle>
                </CardHeader>
              </Card>
            ))}
          </Grid>

          {mapsQuery ? (
            <Stack
              gap={0}
              className="relative aspect-square w-full overflow-hidden rounded-2xl border border-border"
            >
              <iframe
                title={`Map showing ${address}`}
                src={`https://www.google.com/maps?q=${mapsQuery}&z=16&output=embed`}
                className="absolute inset-0 h-full w-full border-0"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
              <Row justify="center" className="absolute inset-x-8 bottom-8">
                <Link
                  href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    buttonVariants(),
                    "h-12 w-full text-[10px] font-black uppercase tracking-widest",
                  )}
                >
                  Open in Google Maps
                </Link>
              </Row>
            </Stack>
          ) : null}
        </Grid>
      </Stack>
    </Section>
  );
}

/* ──────────────────────────────── faq ────────────────────────────────── */

export type TenantFaqProps = { faqs: { question: string; answer: string }[] };

export function TenantFaq({ faqs }: TenantFaqProps) {
  if (faqs.length === 0) return null;
  return (
    <Section
      id="faq"
      maxWidth="full"
      border="bottom"
      tone="muted"
      data-testid="landing-section-faq"
    >
      <Stack gap={0} className="py-24">
        <SectionIntro align="left" eyebrow="Information desk" title="Common questions" />
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

/* ──────────────────────────────── cta ────────────────────────────────── */

export type TenantCtaProps = { tenantName: string; cta: Cta };

export function TenantCta({ tenantName, cta }: TenantCtaProps) {
  return (
    <Section
      maxWidth="full"
      className="premium-dots relative overflow-hidden"
      data-testid="landing-section-cta"
    >
      <Stack gap={8} className="items-center py-32 text-center">
        <Row
          items="center"
          gap={2}
          className="rounded-full border border-primary/20 bg-primary/10 px-4 py-2"
        >
          <span className="text-xs font-black uppercase tracking-[0.2em] text-primary">
            Join the squad
          </span>
        </Row>
        <h2 className="max-w-3xl text-balance text-5xl font-black uppercase leading-[1.1] tracking-widest md:text-6xl">
          Ready for your next session?
        </h2>
        <p className={LEAD}>
          Check rates, reserve ahead, or drop by {tenantName} today.
        </p>
        <Row wrap gap={4} justify="center">
          <Link
            href={cta?.href ?? "/stations"}
            className={cn(buttonVariants(), PILL_CTA, "h-16 px-10 text-sm")}
          >
            {cta?.label ?? "See live availability"}
          </Link>
          <Link
            href="/portal/login"
            className={cn(
              buttonVariants({ variant: "outline" }),
              PILL_CTA,
              "h-16 px-10 text-sm",
            )}
          >
            Member sign in
          </Link>
        </Row>
      </Stack>
    </Section>
  );
}
