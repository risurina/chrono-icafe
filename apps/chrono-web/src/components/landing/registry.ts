import {
  buildLandingSectionRegistry,
  defineLandingSection,
  type LandingSectionContext,
  type ResolvedLandingConfig,
} from "agora";
import {
  TenantHero,
  TenantStations,
  TenantRates,
  TenantSpecs,
  TenantGames,
  TenantTestimonials,
  TenantEvents,
  TenantAbout,
  TenantContact,
  TenantFaq,
  TenantCta,
  TenantExperience,
  TenantPlayerCta,
  TenantShare,
  type TenantStationsProps,
  type Rate,
} from "./tenant-sections";
import type { PublicVenueInfoResponse } from "@/lib/venue";

/**
 * Chrono's own live-data shape, carried through
 * `LandingSectionContext.data` — the foundation's untyped seam for
 * request-time data (it cannot know an app's shape at its own build time).
 * Narrowed here, once, so every `propsFrom` below stays typed.
 */
export type ChronoLandingData = {
  stations?: {
    branches: TenantStationsProps["branches"];
    aggregate: TenantStationsProps["aggregate"];
  } | null;
  /** Real business info + published rates — `/public/venue-info`. */
  venue?: PublicVenueInfoResponse | null;
};

/** "30.00" -> "₱30"; "30.50" -> "₱30.50". Trailing ".00" is noise on a price. */
function formatPeso(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `₱${amount}`;
  return `₱${Number.isInteger(n) ? n.toString() : n.toFixed(2)}`;
}

/**
 * Real station-group rates -> rate cards. One card per group.
 *
 * Groups priced at zero are DROPPED: `hourlyRate` is `notNull().default("0")`,
 * so an unpriced group would otherwise publish "₱0 / hr" to the public. A
 * `memberRate` becomes a sub-line on the same card, never a second card and
 * never an invented feature bullet — `features` stays empty because a rate
 * group carries a price, not a feature list.
 */
function toRateCards(venue: PublicVenueInfoResponse | null | undefined): readonly Rate[] {
  return (venue?.rateGroups ?? [])
    .filter((g) => Number(g.hourlyRate) > 0)
    .map((g) => ({
      title: g.name,
      price: formatPeso(g.hourlyRate),
      period: "/ hr",
      features: [] as readonly string[],
      note:
        g.memberRate && Number(g.memberRate) > 0 && g.memberRate !== g.hourlyRate
          ? `Members ${formatPeso(g.memberRate)} / hr`
          : undefined,
    }));
}

/** The tenant's distinct REAL station types, in first-seen order. */
function distinctStationTypes(data: ChronoLandingData): readonly string[] {
  const seen = new Set<string>();
  for (const branch of data.stations?.branches ?? []) {
    for (const station of branch.stations) {
      if (station.stationType) seen.add(station.stationType);
    }
  }
  return [...seen];
}

const chronoData = (ctx: LandingSectionContext): ChronoLandingData =>
  (ctx.data ?? {}) as ChronoLandingData;

/**
 * Chrono's landing section vocabulary.
 *
 * The foundation owns the machinery; this file owns *which sections exist* and
 * *what they say before a tenant configures anything*. Adding one is a single
 * entry — pages render whatever `resolveLandingSections()` returns, so no page
 * file changes and a future app re-skins by swapping this map rather than
 * editing layout code.
 *
 * `defaultOrder` is spaced by 10 so a section can be slotted between two
 * others without renumbering the rest.
 */

/**
 * Placeholder content, so a brand-new tenant's page reads as finished rather
 * than half-empty. These are venue-shaped defaults, NOT claims about a specific
 * venue — each is replaced the moment the tenant fills the matching field.
 *
 * TODO: `rates` / `specs` / `games` / `testimonials` are not yet part of
 * `landingConfigSchema`. They become tenant-editable by extending chrono's
 * config with a `venue` block (`landingConfigSchema.extend({ … })`, per
 * `.ai/rules/business-app.md`) and reading it here — the components already
 * take the data as props, so only these `propsFrom` bodies change.
 */
const DEFAULTS = {
  specs: {
    cpu: "Ryzen 7 class CPU",
    gpu: "RTX-class graphics",
    monitor: "High-refresh gaming monitor",
    ram: "16GB dual-channel",
    peripherals: "Mechanical keyboard & gaming mouse",
    network: "Fibre internet",
    comfort: "Ergonomic gaming chairs",
  },
  games: [
    "Valorant",
    "Dota 2",
    "League of Legends",
    "CS2",
    "Mobile Legends",
    "Roblox",
    "Minecraft",
    "Steam library",
  ],
  badges: ["Fast stations", "Clean lounge", "Friendly community", "Competitive setup"],
} as const;

const HERO_GAME_TAGS = ["Valorant", "Dota 2", "CS2", "League of Legends"] as const;

export const CHRONO_LANDING_SECTIONS = buildLandingSectionRegistry({
  hero: defineLandingSection({
    key: "hero",
    label: "Hero",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 10,
    Component: TenantHero,
    propsFrom: (r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      title: r.hero.title ?? ctx.tenantName,
      subtitle: r.hero.subtitle,
      eyebrow: r.hero.eyebrow ?? "Gaming lounge & café",
      primaryCta: r.hero.primaryCta ?? { label: "View rates", href: "#rates" },
      secondaryCta: r.hero.secondaryCta ?? { label: "Find us", href: "#location" },
      branchName: ctx.tenantName,
      // Same live snapshot the station matrix renders, so the hero gauges can
      // never disagree with the grid below them.
      summary: chronoData(ctx).stations?.aggregate ?? null,
      specLines: [DEFAULTS.specs.gpu, DEFAULTS.specs.network].filter(Boolean),
      gameTags: HERO_GAME_TAGS,
    }),
  }),
  stations: defineLandingSection({
    key: "stations",
    label: "Station matrix",
    surface: "tenant",
    defaultEnabled: true,
    // Between hero (10) and rates (20) — a visitor checks whether there's a
    // free seat before they check what it costs.
    defaultOrder: 15,
    Component: TenantStations,
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => {
      const live = chronoData(ctx).stations;
      return { branches: live?.branches ?? [], aggregate: live?.aggregate ?? null };
    },
  }),
  rates: defineLandingSection({
    key: "rates",
    label: "Rates",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 20,
    Component: TenantRates,
    // Real, tenant-set rates from `ChronoStationGroups` — never placeholders.
    // An outage makes `venue` null, which yields an empty list, which renders
    // no section at all (see TenantRates' own note on why there is no default).
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      rates: toRateCards(chronoData(ctx).venue),
    }),
  }),
  experience: defineLandingSection({
    key: "experience",
    label: "Gaming experience",
    surface: "tenant",
    defaultEnabled: true,
    // Between stations (15) and rates (20)... but after the join CTA at 18,
    // so: what's free -> how to join -> what you can play on -> what it costs.
    defaultOrder: 35,
    Component: TenantExperience,
    // Derived from the ALREADY-FETCHED station payload — no extra API call.
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      stationTypes: distinctStationTypes(chronoData(ctx)),
    }),
  }),
  playerCta: defineLandingSection({
    key: "playerCta",
    label: "Join / sign in",
    surface: "tenant",
    defaultEnabled: true,
    // Right after live availability: the visitor has just seen a free seat.
    defaultOrder: 18,
    Component: TenantPlayerCta,
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      tenantName: ctx.tenantName,
    }),
  }),
  specs: defineLandingSection({
    key: "specs",
    label: "Station specs",
    surface: "tenant",
    // Off by default: `DEFAULTS.specs` is a fixed, non-tenant-specific hardware
    // list, so leaving it on advertises kit a venue may not own. Same reasoning
    // and same one-line fix as `testimonials`/`events` below. A tenant can still
    // switch it back on from the sections editor. Making it genuinely
    // tenant-editable needs the `venue` config block in the TODO above.
    defaultEnabled: false,
    defaultOrder: 30,
    Component: TenantSpecs,
    propsFrom: () => ({ specs: DEFAULTS.specs }),
  }),
  games: defineLandingSection({
    key: "games",
    label: "Games",
    surface: "tenant",
    // Off by default, same reason as `specs`: `DEFAULTS.games` is a fixed
    // 8-title list, not this venue's actual library.
    defaultEnabled: false,
    defaultOrder: 40,
    Component: TenantGames,
    propsFrom: () => ({ games: DEFAULTS.games }),
  }),
  about: defineLandingSection({
    key: "about",
    label: "About",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 50,
    Component: TenantAbout,
    propsFrom: (r: ResolvedLandingConfig) => ({
      title: r.about.title ?? "About us",
      body: r.about.body,
    }),
  }),
  testimonials: defineLandingSection({
    key: "testimonials",
    label: "Testimonials",
    surface: "tenant",
    // Off by default: real quotes are the tenant's to supply, and inventing
    // customer praise on their behalf would be fabricating a review.
    defaultEnabled: false,
    defaultOrder: 60,
    Component: TenantTestimonials,
    propsFrom: () => ({ badges: DEFAULTS.badges }),
  }),
  events: defineLandingSection({
    key: "events",
    label: "Events & tournaments",
    surface: "tenant",
    defaultEnabled: false,
    defaultOrder: 70,
    Component: TenantEvents,
    propsFrom: () => ({}),
  }),
  contact: defineLandingSection({
    key: "contact",
    label: "Contact & location",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 80,
    Component: TenantContact,
    propsFrom: (r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      ...r.contact,
      // Real profiles from the tenant's own branch record — rendered only when
      // set, so a venue with no TikTok never shows a dead TikTok link.
      socialLinks: chronoData(ctx).venue?.branch?.socialLinks ?? null,
    }),
  }),
  faq: defineLandingSection({
    key: "faq",
    label: "FAQ",
    surface: "tenant",
    // Off unless the tenant actually writes FAQs — an empty accordion is worse
    // than no section.
    defaultEnabled: false,
    defaultOrder: 90,
    Component: TenantFaq,
    propsFrom: (r: ResolvedLandingConfig) => ({ faqs: r.faqs }),
  }),
  share: defineLandingSection({
    key: "share",
    label: "Share this venue",
    surface: "tenant",
    defaultEnabled: true,
    // Late on the page, just before the closing CTA — a visitor shares once
    // they have already decided they like the place.
    defaultOrder: 95,
    Component: TenantShare,
    propsFrom: (_r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      tenantName: ctx.tenantName,
    }),
  }),
  cta: defineLandingSection({
    key: "cta",
    label: "Closing call to action",
    surface: "tenant",
    defaultEnabled: true,
    defaultOrder: 100,
    Component: TenantCta,
    propsFrom: (r: ResolvedLandingConfig, ctx: LandingSectionContext) => ({
      tenantName: ctx.tenantName,
      cta: r.hero.primaryCta,
    }),
  }),
});

/** Labels for the dashboard's sections editor. */
export const TENANT_SECTION_CHOICES = Object.values(CHRONO_LANDING_SECTIONS).map(
  (def) => ({ key: def.key, label: def.label }),
);
