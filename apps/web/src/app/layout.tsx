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
