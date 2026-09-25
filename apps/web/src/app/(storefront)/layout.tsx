import Link from "next/link";
import { Suspense } from "react";

import { LogoLink } from "@/components/brand/logo";
import { WhatsAppButton } from "@/components/commerce/whatsapp-button";
import { AnnouncementBar } from "@/components/commerce/announcement-bar";
import { CartButton } from "@/components/commerce/cart-button";
import { MobileNav } from "@/components/commerce/mobile-nav";
import { NavFallback } from "@/components/commerce/nav-fallback";
import { PrimaryNav } from "@/components/commerce/primary-nav";
import { SearchBar } from "@/components/commerce/search-bar";
import { SiteHeader } from "@/components/commerce/site-header";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { RouteFade } from "@/components/ui/route-fade";
import type { NavigationNode } from "@/lib/api/types";
import { getNavigation } from "@/lib/navigation/navigation";

/**
 * The navbar is data, not code (ADR-0009): one fetch of `/shop/navigation/`
 * resolves overrides, then categories, then a static fallback. Nothing here
 * knows what "Women" is.
 *
 * There is deliberately no account control. A shopper cannot create an account
 * -- `auth/register/` has no screen in front of it -- so an "account" menu
 * offered a sign-in that only staff could complete and a wishlist that silently
 * failed for everyone else. Staff reach `/admin` and `/pos` by typing the
 * address; `/login` still exists and still works, it just is not advertised
 * here. Dropping it also takes the layout's cookie read with it.
 */
export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  const navigation = await getNavigation();
  const footerLinks = navigation.footer.length ? navigation.footer : navigation.items.slice(0, 5);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Above the sticky header, so it scrolls away naturally. */}
      <AnnouncementBar banner={navigation.announcement} />

      <SiteHeader>
        <div className="container-rangon">
          <div className="flex h-16 items-center gap-2 sm:gap-4">
            <MobileNav items={navigation.items} />

            {/* Navbar sits on a white surface -> dark wordmark. The logo scales
                on scroll; the header's own height never changes, so nothing
                below it reflows. */}
            <span className="origin-left transition-transform duration-normal ease-rangon group-data-[scrolled]:scale-90">
              <LogoLink variant="full-on-light" height={32} priority />
            </span>

            {/* Navigation must never take the storefront down (spec §37). */}
            <ErrorBoundary label="PrimaryNav" fallback={<NavFallback items={navigation.items} />}>
              <PrimaryNav items={navigation.items} />
            </ErrorBoundary>

            <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
              {/* SearchBar reads ?q= via useSearchParams; without this boundary the
                  whole layout bails out of static rendering at build time. */}
              <Suspense fallback={<div className="h-10 w-10" aria-hidden />}>
                <SearchBar />
              </Suspense>
              <CartButton />
            </div>
          </div>
        </div>
      </SiteHeader>

      <main id="main" className="flex-1">
        <RouteFade>{children}</RouteFade>
      </main>

      <footer className="mt-16 border-t border-border bg-neutral-950 text-neutral-300">
        <div className="container-rangon grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-4">
            {/* Footer is near-black -> vertical lockup, white wordmark. */}
            <LogoLink variant="vertical-on-dark" height={132} />
            <p className="max-w-xs text-body-sm text-neutral-400">
              Clothing, shoes, bags and cosmetics — online and at our Dhaka store.
            </p>
          </div>

          <FooterColumn
            title="Shop"
            links={footerLinks.map((item: NavigationNode) => ({
              label: item.label,
              href: item.url,
            }))}
          />
          <FooterColumn
            title="Help"
            links={[
              { label: "Track your order", href: "/track" },
              { label: "Shipping", href: "/policies/shipping" },
              { label: "Returns & exchanges", href: "/policies/returns" },
              { label: "Contact us", href: "/contact" },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: "About", href: "/about" },
              { label: "Privacy", href: "/policies/privacy" },
              { label: "Terms", href: "/policies/terms" },
            ]}
          />
        </div>

        <div className="border-t border-neutral-800">
          {/* neutral-400, not 500: #737373 on the footer's #0A0A0A is 4.17:1. */}
          <div className="container-rangon flex flex-col gap-2 py-6 text-caption text-neutral-400 sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} Rangon Fashion. All rights reserved.</p>
            <p>Cash on delivery available across Bangladesh.</p>
          </div>
        </div>
      </footer>

      {/* Renders nothing unless NEXT_PUBLIC_WHATSAPP_NUMBER is set. */}
      <WhatsAppButton />
    </div>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h2 className="text-body-sm font-semibold uppercase tracking-wide text-white">{title}</h2>
      <ul className="mt-4 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-body-sm text-neutral-400 hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
