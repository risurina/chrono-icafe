import type { Metadata } from "next";
import { Inter, Bruno_Ace_SC } from "next/font/google";
import "agora/ui/globals.css"; // design tokens (CSS vars)
import "./globals.css"; // Tailwind v4 entry + token→utility mapping
import { Providers } from "./providers";
import { getPublicBranding, brandingCss } from "@/lib/branding";
import { themePresetCss } from "agora";
import { CHRONO_THEME_PRESETS } from "@/lib/theme-presets";
import { getTenantLanding } from "@/lib/landing";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

// The Chrono wordmark face. Loaded through next/font so it is hoisted,
// self-hosted and preloaded — the prior-art implementation pulled it from a
// render-blocking CSS `@import`. The variable name is deliberately distinct
// from the `--font-chrono` theme token it feeds: mapping a token to itself in
// `@theme inline` would be a self-reference.
const brunoAceSC = Bruno_Ace_SC({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-chrono-display",
});

const DEFAULT_TITLE = "Chrono — Business management";
const DEFAULT_DESCRIPTION =
  "Business management for gaming centers and internet cafes.";

// Platform default icon set — files live under apps/web/public/favicon/, not
// the public root, so every path below is explicit rather than relying on
// Next's implicit /favicon.ico convention (which 404s with nothing at the root).
const DEFAULT_ICONS: Metadata["icons"] = {
  icon: [
    { url: "/favicon/favicon.ico", sizes: "any" },
    { url: "/favicon/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    { url: "/favicon/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    { url: "/favicon/favicon-96x96.png", sizes: "96x96", type: "image/png" },
  ],
  apple: "/favicon/apple-icon.png",
};

// Per-tenant title + favicon, resolved from the request host. Falls back to the
// platform defaults on the apex or when a tenant has set no branding.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getPublicBranding();
  const title = branding?.displayName?.trim() || DEFAULT_TITLE;
  return {
    title,
    description: branding?.tagline?.trim() || DEFAULT_DESCRIPTION,
    icons: branding?.faviconUrl ? { icon: branding.faviconUrl } : DEFAULT_ICONS,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Both resolve from the same request; run them in parallel rather than
  // serialising two fetches on the critical path of every render.
  const [branding, landing] = await Promise.all([
    getPublicBranding(),
    getTenantLanding(),
  ]);
  const css = brandingCss(branding);
  const presetCss = themePresetCss(CHRONO_THEME_PRESETS, landing?.themePreset);

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${brunoAceSC.variable} font-sans antialiased`}
      >
        {/* Order matters. The preset goes FIRST so the tenant's own
            primaryColor/accentColor (emitted by brandingCss below) still wins
            over it — both are unlayered :root rules at equal specificity, so
            later source order decides. Empty for the default preset, whose
            values already live in globals.css. */}
        {presetCss ? (
          <style
            id="chrono-theme-preset"
            dangerouslySetInnerHTML={{ __html: presetCss }}
          />
        ) : null}
        {/* Tenant color tokens + sanitized custom CSS, inlined into the initial
            HTML so branded colors paint on first render (no layout shift). */}
        {css ? (
          <style
            id="tenant-branding"
            dangerouslySetInnerHTML={{ __html: css }}
          />
        ) : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
