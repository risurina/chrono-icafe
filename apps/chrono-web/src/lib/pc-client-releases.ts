/**
 * Chrono PC Client release feed.
 *
 * The PC Client is a real, code-signed Tauri v2 desktop app that ships its
 * releases from `izur-it/chrono` (public GitHub repo, releases-only — its
 * actual source lives outside this workspace). GitHub is the sole source of
 * truth here: nothing is mirrored locally, there is no tenant table, and no
 * `apps/chrono-api` route sits in front of it — this file calls the public
 * GitHub REST API directly from the Next.js server. See
 * `.ai/plans/chrono/ready/app-versions/README.md` for the full investigation
 * that established this (the plan is archived once this phase lands).
 *
 * Unauthenticated GitHub calls are rate-limited to 60/hr per source IP.
 * `next: { revalidate: 300 }` (5 min) keeps real GitHub calls low regardless
 * of visitor traffic and gives a last-known-good cached response if GitHub is
 * briefly unreachable — the plan's stated default. A `GITHUB_RELEASES_TOKEN`
 * env var is a documented future option if production logs ever show
 * rate-limit errors; not needed today, so it is not added speculatively.
 */

const RELEASES_API_URL = "https://api.github.com/repos/izur-it/chrono/releases";

type GitHubAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
};

/**
 * Transport shape for this page only — deliberately not a `packages/agora`
 * contract. This is external, app-specific data, not a cross-app DTO.
 */
export type PcClientRelease = {
  version: string;
  publishedAt: string;
  sizeBytes: number;
  downloadUrl: string;
  notes: string;
  isLatest: boolean;
};

type NormalizedRelease = Omit<PcClientRelease, "isLatest"> & {
  prerelease: boolean;
};

/** The Windows installer asset — `*-setup.exe`, falling back to any `.exe`/`.msi`. */
function pickInstallerAsset(assets: GitHubAsset[]): GitHubAsset | null {
  return (
    assets.find((asset) => /setup\.exe$/i.test(asset.name)) ??
    assets.find((asset) => /\.(exe|msi)$/i.test(asset.name)) ??
    null
  );
}

/** Drops drafts and releases with no Windows installer asset attached. */
function normalize(data: GitHubRelease[]): NormalizedRelease[] {
  const releases: NormalizedRelease[] = [];
  for (const release of data) {
    if (release.draft) continue;
    const asset = pickInstallerAsset(release.assets ?? []);
    if (!asset) continue;
    releases.push({
      version: release.tag_name.replace(/^v/i, ""),
      publishedAt: release.published_at ?? "",
      sizeBytes: asset.size,
      downloadUrl: asset.browser_download_url,
      notes: release.body ?? "",
      prerelease: release.prerelease,
    });
  }
  return releases;
}

/**
 * Every published, non-draft release with a Windows installer asset, newest
 * first (GitHub's own ordering). `isLatest` marks the first non-prerelease
 * entry, falling back to the first entry overall if every release happens to
 * be a prerelease. Returns `[]` on any fetch/shape failure — never throws —
 * so the page can render its own fallback state instead of a 500.
 */
export async function getPcClientReleases(): Promise<PcClientRelease[]> {
  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];

    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];

    const releases = normalize(data as GitHubRelease[]);
    if (releases.length === 0) return [];

    const latestIndex = releases.findIndex((release) => !release.prerelease);
    const idx = latestIndex === -1 ? 0 : latestIndex;

    return releases.map((release, i) => ({
      version: release.version,
      publishedAt: release.publishedAt,
      sizeBytes: release.sizeBytes,
      downloadUrl: release.downloadUrl,
      notes: release.notes,
      isLatest: i === idx,
    }));
  } catch {
    return [];
  }
}
