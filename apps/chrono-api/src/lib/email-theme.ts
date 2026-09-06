import { readPublishedLandingPage } from "agora/server/routes";
import { CHRONO_THEME_PRESETS } from "../contracts/theme-presets";
import type { EmailThemeTokens } from "agora/server";

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function flattenAlphaOverSolid(hex8: string, underSurface: string): string {
  const rFg = parseInt(hex8.slice(1, 3), 16);
  const gFg = parseInt(hex8.slice(3, 5), 16);
  const bFg = parseInt(hex8.slice(5, 7), 16);
  const a = parseInt(hex8.slice(7, 9), 16) / 255;

  const rBg = parseInt(underSurface.slice(1, 3), 16);
  const gBg = parseInt(underSurface.slice(3, 5), 16);
  const bBg = parseInt(underSurface.slice(5, 7), 16);

  const r = Math.min(255, Math.max(0, Math.round(rFg * a + rBg * (1 - a))));
  const g = Math.min(255, Math.max(0, Math.round(gFg * a + gBg * (1 - a))));
  const b = Math.min(255, Math.max(0, Math.round(bFg * a + bBg * (1 - a))));

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Expand 3-digit shorthand, flatten an 8-digit alpha hex over a solid
 * `underSurface`, and drop anything that still isn't a plain 6-digit hex —
 * the foundation's color guard would otherwise silently drop it, and this
 * makes that explicit and correct here instead of an unexplained gap
 * downstream. */
function normalizeHex(value: string, underSurface: string): string | undefined {
  let v = value;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  }
  if (/^#[0-9a-fA-F]{8}$/.test(v)) {
    // Flatten alpha over `underSurface` (both already 6-digit by this point
    // in the token map's declared order — background/card resolve first).
    v = flattenAlphaOverSolid(v, underSurface);
  }
  return HEX6.test(v) ? v : undefined;
}

function mapPresetTokens(
  tokens: Record<string, string>,
): Partial<EmailThemeTokens> {
  const card = normalizeHex(tokens.card ?? "", "#ffffff") ?? "#ffffff";
  return {
    background: normalizeHex(tokens.background ?? "", "#ffffff"),
    card,
    foreground: normalizeHex(tokens.foreground ?? "", "#ffffff"),
    mutedForeground: normalizeHex(tokens["muted-foreground"] ?? "", "#ffffff"),
    border: normalizeHex(tokens.border ?? "", card),
    primary: normalizeHex(tokens.primary ?? "", card),
    primaryForeground: normalizeHex(tokens["primary-foreground"] ?? "", card),
  };
}

/**
 * `tenantId` MUST come from already-resolved server context (`c.var.tenant`
 * / a foundation call site's own tenant id) — never client input — since
 * `readPublishedLandingPage` uses `withAdmin` and bypasses RLS (documented
 * in `apps/chrono-api/AGENTS.md`'s "Landing pages" section; the explicit
 * `tenantId` filter is the only isolation on that path). Every real caller
 * today already satisfies this (`member/routes.ts`'s `c.var.tenant`,
 * `agora/member-auth`'s own resolved `tenantId`) — this is a contract for
 * future callers, not a fix.
 *
 * Runs one `readPublishedLandingPage` read per call — no caching layer.
 * Accepted for this pass: email sends are not a hot path, and the read
 * already fails open (returns `null`) on any error, so an expensive read
 * degrades to an unthemed email rather than a failed send.
 */
export async function resolveChronoEmailTheme(
  tenantId: string,
): Promise<{ light: Partial<EmailThemeTokens>; dark: Partial<EmailThemeTokens> } | null> {
  try {
    const published = await readPublishedLandingPage(tenantId);
    const key = published?.snapshot.themePreset ?? CHRONO_THEME_PRESETS.defaultKey;
    const preset = CHRONO_THEME_PRESETS.presets[key] ?? CHRONO_THEME_PRESETS.presets[CHRONO_THEME_PRESETS.defaultKey];
    if (!preset) return null;
    return { light: mapPresetTokens(preset.light), dark: mapPresetTokens(preset.dark) };
  } catch {
    return null; // fail-open — a themed email is not delivery-critical
  }
}
