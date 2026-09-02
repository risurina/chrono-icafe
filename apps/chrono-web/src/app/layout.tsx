import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "agora/ui/globals.css"; // design tokens (CSS vars)
import "./globals.css"; // Tailwind v4 entry + token→utility mapping
import { Providers } from "./providers";
import { getPublicBranding, brandingCss } from "@/lib/branding";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const DEFAULT_TITLE = "Chrono — Venue management";
const DEFAULT_DESCRIPTION =
  "Venue management for gaming centers and internet cafes.";

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
  const branding = await getPublicBranding();
  const css = brandingCss(branding);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
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
