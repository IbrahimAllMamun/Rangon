import Link from "next/link";

import { LogoLink } from "@/components/brand/logo";
import { CartButton } from "@/components/commerce/cart-button";
import { MobileNav } from "@/components/commerce/mobile-nav";
import { SearchBar } from "@/components/commerce/search-bar";
import { apiServer } from "@/lib/api/server";

interface NavCategory {
  name: string;
  slug: string;
  children: { name: string; slug: string }[];
}

async function getNavigation(): Promise<NavCategory[]> {
  try {
    // Navigation changes rarely; cache it and let a category edit revalidate.
    return await apiServer<NavCategory[]>("/shop/categories/", {
      auth: false,
      revalidate: 300,
      tags: ["categories"],
    });
  } catch {
    return [];
  }
}

export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  const categories = await getNavigation();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur-sm">
        <div className="container-rangon">
          <div className="flex h-16 items-center gap-4">
            <MobileNav categories={categories} />
            {/* Navbar sits on a white surface -> dark wordmark. */}
            <LogoLink variant="full-on-light" height={32} priority />

            <nav aria-label="Main" className="hidden lg:block">
              <ul className="flex items-center gap-1">
                {categories.map((category) => (
                  <li key={category.slug} className="group relative">
                    <Link
                      href={`/shop?category=${category.slug}`}
                      className="inline-flex h-16 items-center px-3 text-body-sm font-medium text-neutral-700 hover:text-brand-600"
                    >
                      {category.name}
                    </Link>
                    {category.children.length > 0 && (
                      <div className="invisible absolute left-0 top-full z-50 w-56 rounded-lg border border-border bg-surface p-2 opacity-0 shadow-md transition-opacity duration-fast group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                        <ul>
                          {category.children.map((child) => (
                            <li key={child.slug}>
                              <Link
                                href={`/shop?category=${child.slug}`}
                                className="block rounded-md px-3 py-2 text-body-sm text-neutral-700 hover:bg-neutral-100"
                              >
                                {child.name}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </nav>

            <div className="ml-auto flex items-center gap-1">
              <SearchBar />
              <Link
                href="/account"
                className="hidden rounded-md p-2 text-neutral-700 hover:bg-neutral-100 sm:inline-flex"
                aria-label="Your account"
              >
                <AccountIcon />
              </Link>
              <CartButton />
            </div>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
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
            links={categories.slice(0, 5).map((c) => ({ label: c.name, href: `/shop?category=${c.slug}` }))}
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
            title="Rangon"
            links={[
              { label: "About", href: "/about" },
              { label: "Privacy", href: "/policies/privacy" },
              { label: "Terms", href: "/policies/terms" },
            ]}
          />
        </div>

        <div className="border-t border-neutral-800">
          <div className="container-rangon flex flex-col gap-2 py-6 text-caption text-neutral-500 sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} Rangon Fashion. All rights reserved.</p>
            <p>Cash on delivery available across Bangladesh.</p>
          </div>
        </div>
      </footer>
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

function AccountIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
