import { Suspense } from "react";

import { LogoLink } from "@/components/brand/logo";
import { WhatsAppButton } from "@/components/commerce/whatsapp-button";
import { AnnouncementBar } from "@/components/commerce/announcement-bar";
import { CartButton } from "@/components/commerce/cart-button";
import { MobileNav } from "@/components/commerce/mobile-nav";
import { NavFallback } from "@/components/commerce/nav-fallback";
import { PrimaryNav } from "@/components/commerce/primary-nav";
import { SearchBar } from "@/components/commerce/search-bar";
import { SiteFooter } from "@/components/commerce/site-footer";
import { SiteHeader } from "@/components/commerce/site-header";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { RouteFade } from "@/components/ui/route-fade";
import { getNavigation } from "@/lib/navigation/navigation";
import { getSite } from "@/lib/site/site";

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
 *
 * The footer is data too (ADR-0012): `/shop/site/`, fetched alongside the
 * navbar and cached the same way, with its own static fallback.
 */
export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  const [navigation, site] = await Promise.all([getNavigation(), getSite()]);

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

      <SiteFooter site={site} />

      {/* Renders nothing unless the shop has a WhatsApp number set up. */}
      <WhatsAppButton whatsapp={site.whatsapp} />
    </div>
  );
}
