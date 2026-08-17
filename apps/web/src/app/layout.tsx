import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

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
        {children}
      </body>
    </html>
  );
}
