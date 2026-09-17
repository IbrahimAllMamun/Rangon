import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { RouteTransitionProvider } from "@/lib/navigation/route-transition";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans-loaded",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display-loaded",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Every page renders per request, because every page is served under a
 * per-request CSP nonce (`src/middleware.ts`).
 *
 * This is not a preference — the two are mutually exclusive. Next stamps the
 * nonce onto its script tags at *render* time, so a page prerendered at build
 * time carries none, while the response it is served with still demands one.
 * `script-src` then blocks all of it: the chunk `<script src>` tags, because
 * `'strict-dynamic'` makes browsers ignore `'self'`, and the thirteen inline
 * `self.__next_f.push(...)` tags carrying the RSC payload, which no host-source
 * expression can ever allow. React never boots, and a page whose body is a
 * client component behind `<Suspense>` renders literally nothing (D74).
 *
 * That is what shipped: `/`, `/login`, `/cart`, `/checkout`, `/about`,
 * `/brand`, `/contact` and `/policies/*` were all statically prerendered and
 * therefore inert in the browser. `/login` was the visible one — a white
 * screen, no form, and no way into `/admin` at all — but `/checkout` was the
 * expensive one.
 *
 * The alternative is `'unsafe-inline'`, which is the one thing the nonce exists
 * to avoid. So: dynamic everywhere. The catalogue routes (`/shop`,
 * `/product/[slug]`, `/category/[...slug]`) were already dynamic and lose
 * nothing; the pages that change here are marketing copy and two that should
 * never have been shared caches anyway, `/cart` and `/checkout`.
 *
 * Do not "optimise" this back to static without removing the nonce first, and
 * read D16 before removing the nonce.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Rangon Fashion",
    template: "%s | Rangon Fashion",
  },
  description:
    "Clothing, shoes, bags and cosmetics from Rangon Fashion. Shop online or visit us in Dhaka.",
  icons: {
    // Browser tab: the standalone symbol from the official asset set.
    icon: [{ url: "/brand/logo/logo.svg", type: "image/svg+xml" }],
    shortcut: "/brand/logo/logo.svg",
    apple: "/brand/logo/logo.svg",
  },
  openGraph: {
    type: "website",
    siteName: "Rangon Fashion",
    locale: "en_GB",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#111111",
  width: "device-width",
  initialScale: 1,
  // Never disable zoom (WCAG 1.4.4).
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <head>
        {/* Scroll reveals start hidden and are shown by JS. If scripts never
            run, this keeps the catalogue readable instead of blank. */}
        <noscript>
          <style>{`[data-reveal]{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
      </head>
      <body
        style={
          {
            // Bind the loaded webfonts to the design tokens, keeping the token
            // layer the single source of typography.
            "--font-sans": `var(--font-sans-loaded), system-ui, sans-serif`,
            "--font-display": `var(--font-display-loaded), var(--font-sans-loaded), sans-serif`,
          } as React.CSSProperties
        }
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {/* Every navigation reports itself here: an immediate progress bar, and
            the logo loader if the wait turns out to be a real one. Same-segment
            navigations (filters, pagination) have no `loading.tsx` to fall back
            on, so without this they look like the app has frozen. */}
        <RouteTransitionProvider>{children}</RouteTransitionProvider>
      </body>
    </html>
  );
}
