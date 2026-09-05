import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  ChevronDown,
  Cpu,
  Download,
  HardDrive,
  MonitorCog,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardTitle,
  Grid,
  Row,
  Section,
  SectionHeading,
  Stack,
  buttonVariants,
  cn,
} from "agora/ui";
import {
  getPcClientReleases,
  type PcClientRelease,
} from "@/lib/pc-client-releases";

/**
 * Public PC-client download page — renders inside the `(apex-marketing)`
 * route group's shared shell (`layout.tsx`), which already supplies
 * `MarketingHeader`/`MarketingFooter`, so this file is content only.
 *
 * Release data comes straight from `getPcClientReleases()`
 * (`@/lib/pc-client-releases`), which reads `izur-it/chrono`'s public GitHub
 * releases feed server-side with a 5-minute revalidate. No tenant context, no
 * `/rpc` route, no local table — see
 * `.ai/plans/chrono/ready/app-versions/README.md` for why.
 *
 * Layout/UX mirrors the oikos reference
 * (`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/download/download-client.tsx`)
 * but is rebuilt fresh from `agora/ui` primitives and semantic tokens — no
 * raw chrome, no hardcoded color literals, no `dangerouslySetInnerHTML`.
 */

export const metadata: Metadata = {
  title: "Download — Chrono",
  description:
    "Download the Chrono PC Client for Windows to run managed sessions, wallets, and branch operations on your cafe workstations.",
};

const RELEASES_LIST_URL = "https://github.com/izur-it/chrono/releases";
const RELEASES_LATEST_URL = `${RELEASES_LIST_URL}/latest`;

const REQUIREMENTS = [
  {
    icon: MonitorCog,
    title: "Windows 10 / 11",
    description: "64-bit desktop edition.",
  },
  {
    icon: Cpu,
    title: "x64 processor",
    description: "Modern dual-core or better.",
  },
  {
    icon: HardDrive,
    title: "~200 MB free",
    description: "For install and runtime cache.",
  },
  {
    icon: ShieldCheck,
    title: "Admin install",
    description: "Setup registers the guard service.",
  },
] as const;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(date);
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Inline `**bold**` rendering for a single line of a release's notes. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-foreground">
          {bold[1]}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

/**
 * Minimal, dependency-free markdown for GitHub release notes: headings,
 * bullet/numbered lists, bold, and paragraphs — the subset the PC Client's
 * own releases actually use (checked against the live feed while planning
 * this page). Notes are authored by Chrono's own release process, so no HTML
 * sanitization is required — this never touches `dangerouslySetInnerHTML`.
 */
function renderNotes(notes: string): ReactNode[] {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: string) => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={key} className="list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const key = `n-${idx}`;
    if (/^#{1,6}\s+/.test(line)) {
      flushList(`${key}-l`);
      blocks.push(
        <h4 key={key} className="mt-3 text-sm font-bold text-foreground">
          {renderInline(line.replace(/^#{1,6}\s+/, ""), key)}
        </h4>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (/^\d+\.\s+/.test(line)) {
      list.push(line.replace(/^\d+\.\s+/, ""));
    } else if (line.trim() === "") {
      flushList(`${key}-l`);
    } else {
      flushList(`${key}-l`);
      blocks.push(
        <p key={key} className="leading-relaxed">
          {renderInline(line, key)}
        </p>,
      );
    }
  });

  flushList("final");
  return blocks;
}

function ReleaseCard({ release }: { release: PcClientRelease }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <Row
          gap={4}
          wrap
          className="flex-col items-start justify-between sm:flex-row sm:items-center"
        >
          <Stack gap={2}>
            <Row items="center" gap={2} wrap>
              <span className="text-lg font-bold text-foreground">
                v{release.version}
              </span>
              {release.isLatest && <Badge>Latest</Badge>}
            </Row>
            <span className="text-xs text-muted-foreground">
              {[formatDate(release.publishedAt), formatSize(release.sizeBytes)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </Stack>

          <a
            href={release.downloadUrl}
            download
            className={cn(buttonVariants({ variant: "outline" }), "shrink-0 rounded-full")}
          >
            <Download size={16} className="mr-2" aria-hidden />
            Windows
          </a>
        </Row>

        {release.notes.trim() &&
          (release.isLatest ? (
            <div className="space-y-2 border-t pt-4 text-sm text-muted-foreground">
              {renderNotes(release.notes)}
            </div>
          ) : (
            <details className="group/notes border-t pt-4">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-primary marker:content-none">
                <ChevronDown
                  size={14}
                  className="transition-transform group-open/notes:rotate-180"
                  aria-hidden
                />
                Release notes
              </summary>
              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                {renderNotes(release.notes)}
              </div>
            </details>
          ))}
      </CardContent>
    </Card>
  );
}

export default async function DownloadPage() {
  const releases: PcClientRelease[] = await getPcClientReleases();
  const latest = releases.find((release) => release.isLatest) ?? releases[0] ?? null;
  const latestDownloadUrl = latest?.downloadUrl ?? RELEASES_LATEST_URL;

  return (
    <>
      {/* pt-32 clears the shared fixed 80px header, same as every other
          apex-marketing page's first section. */}
      <Section maxWidth="full" className="pb-16 pt-32">
        <Grid cols={2} gap={4} className="items-center">
          <Stack gap={6}>
            <span className="text-xs font-black uppercase tracking-[0.3em] text-primary">
              Download
            </span>
            <h1 className="text-balance text-3xl font-black tracking-tight sm:text-5xl">
              Get the Chrono PC Client.
            </h1>
            <p className="max-w-lg text-lg leading-8 text-muted-foreground">
              Install the Chrono PC Client on each cafe workstation to run
              managed sessions, wallets, timers, and branch controls. Windows
              64-bit only.
            </p>

            <Grid cols={2} gap={4} className="max-w-lg">
              {REQUIREMENTS.map((req) => {
                const Icon = req.icon;
                return (
                  <Row key={req.title} gap={3} className="rounded-2xl border bg-muted/30 p-5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon size={18} aria-hidden />
                    </div>
                    <Stack gap={1}>
                      <p className="text-sm font-bold text-foreground">{req.title}</p>
                      <p className="text-xs text-muted-foreground">{req.description}</p>
                    </Stack>
                  </Row>
                );
              })}
            </Grid>
          </Stack>

          <Card className="mx-auto w-full max-w-md">
            <CardContent className="flex flex-col items-center gap-6 p-8 text-center sm:p-10">
              <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary/10 text-primary">
                <Download size={40} aria-hidden />
              </div>

              <Stack gap={2} className="items-center">
                <CardTitle className="text-2xl">Chrono PC Client</CardTitle>
                <CardDescription>
                  Windows Installer · x64{latest ? ` · v${latest.version}` : ""}
                </CardDescription>
              </Stack>

              <a
                href={latestDownloadUrl}
                download
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "h-14 w-full rounded-full font-black uppercase tracking-widest text-[10px]",
                )}
              >
                Download for Windows
              </a>

              <a
                href="#releases"
                className="text-xs font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-primary"
              >
                View all releases
              </a>

              <p className="max-w-xs text-xs text-muted-foreground">
                Windows may show a SmartScreen prompt for new installers —
                choose &ldquo;More info&rdquo; then &ldquo;Run anyway&rdquo; to
                continue.
              </p>
            </CardContent>
          </Card>
        </Grid>
      </Section>

      <Section id="releases" maxWidth="full" border="top" className="py-20">
        <Stack gap={8}>
          <SectionHeading
            eyebrow="Releases"
            title="All releases"
            description="Every published Chrono PC Client build. Each entry links directly to its Windows installer."
          />

          {releases.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  The release list is unavailable right now. You can view
                  releases directly on{" "}
                  <a
                    href={RELEASES_LIST_URL}
                    className="font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    GitHub
                  </a>
                  .
                </p>
              </CardContent>
            </Card>
          ) : (
            <Stack gap={4}>
              {releases.map((release) => (
                <ReleaseCard key={release.version} release={release} />
              ))}
            </Stack>
          )}
        </Stack>
      </Section>
    </>
  );
}
