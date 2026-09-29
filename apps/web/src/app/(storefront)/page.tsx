import { ArrowRight, RotateCcw, ShieldCheck, Truck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ProductCard, ProductGrid } from "@/components/commerce/product-card";
import { ProductCarousel } from "@/components/commerce/product-carousel";
import { Button } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { apiServer } from "@/lib/api/server";
import type { ShopProduct, StorefrontBanner } from "@/lib/api/types";

interface HomePayload {
  hero: StorefrontBanner | null;
  /** Chosen at Storefront → Homepage carousel, in that order; only what a shopper can open. */
  carousel: ShopProduct[];
  new_arrivals: ShopProduct[];
  featured: ShopProduct[];
  best_sellers: ShopProduct[];
  price_drops: ShopProduct[];
  brands: { name: string; slug: string; logo: string }[];
}

export const revalidate = 120;

async function getHome(): Promise<HomePayload | null> {
  try {
    return await apiServer<HomePayload>("/shop/home/", {
      auth: false,
      revalidate: 120,
      tags: ["home"],
    });
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const data = await getHome();

  // A merchandiser's hero banner wins; without one the page keeps the copy it
  // has always had and borrows a new arrival's photograph
  // (docs/architecture/navigation.md §2).
  const hero = data?.hero ?? null;
  const heroImage = hero?.image ?? data?.new_arrivals?.[0]?.images?.[0]?.url ?? "";

  return (
    <>
      {/* Hero: photography-led, concise copy, one clear CTA in brand red. */}
      <section className="relative isolate overflow-hidden bg-neutral-950">
        {/* Two columns only when there is a photograph to fill the second.
            Without one the right half used to render an empty near-black box,
            a hole in the most important area of the page; the copy is centred
            instead so the band stays balanced. */}
        <div
          className={`container-rangon grid items-center gap-10 py-16 sm:py-24 lg:py-28 ${
            heroImage ? "lg:grid-cols-2" : ""
          }`}
        >
          <div className={heroImage ? "max-w-xl" : "mx-auto max-w-2xl text-center"}>
            {/* Hero stagger: 60ms apart, 320ms each. Pure CSS so it needs no JS
                and cannot strand text invisible; `both` fill-mode holds the
                from-state through the delay. Reduced motion zeroes both. */}
            <p className="motion-safe:animate-rise-in text-caption font-semibold uppercase tracking-[0.28em] text-brand-400">
              New season
            </p>
            <h1
              style={{ animationDelay: "60ms" }}
              className="font-display motion-safe:animate-rise-in mt-4 text-[2.25rem] font-bold leading-[1.05] text-white sm:text-[3rem] lg:text-display-xl"
            >
              {hero?.title || "Elevate your everyday"}
            </h1>
            <p style={{ animationDelay: "120ms" }} className="motion-safe:animate-rise-in mt-5 text-body-lg text-neutral-300">
              {hero?.subtitle ||
                "Clothing, shoes, bags and cosmetics — chosen for how Dhaka actually dresses."}
            </p>
            <div
              style={{ animationDelay: "180ms" }}
              className={`motion-safe:animate-rise-in mt-8 flex flex-wrap gap-3 ${
                heroImage ? "" : "justify-center"
              }`}
            >
              <Button asChild size="lg">
                <Link href={hero?.url || "/shop"}>
                  {hero?.cta_label || "Shop now"} <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary" className="border-neutral-700 bg-transparent text-white hover:bg-neutral-800">
                <Link href="/shop?sort=newest">See what&apos;s new</Link>
              </Button>
            </div>
          </div>

          {heroImage && (
            <div
              style={{ animationDelay: "120ms" }}
              className="motion-safe:animate-rise-in relative hidden aspect-[4/3] overflow-hidden rounded-xl lg:block"
            >
              <Image
                src={heroImage}
                alt=""
                fill
                priority
                sizes="(max-width: 1024px) 0px, 50vw"
                className="object-cover"
              />
            </div>
          )}
        </div>
      </section>

      {/* Straight under the hero: the products a merchandiser put there, in
          their order. It took the place of "Shop by category", which only
          repeated the navbar. Nothing chosen, nothing shown. */}
      {data?.carousel?.length ? (
        <ProductCarousel id="home-carousel" title="Our picks">
          {data.carousel.map((product, index) => (
            <ProductCard
              key={product.id}
              product={product}
              // On a phone the hero has no photograph, so the first cards here
              // are the largest image on the first screen.
              priority={index < 2}
              sizes="(max-width: 640px) 72vw, (max-width: 768px) 42vw, (max-width: 1024px) 33vw, 25vw"
            />
          ))}
        </ProductCarousel>
      ) : null}

      {/* Trust strip */}
      <section className="border-b border-border bg-surface">
        <Reveal className="container-rangon grid gap-6 py-6 sm:grid-cols-3">
          <Trust icon={<Truck className="size-5" aria-hidden />} title="Delivery nationwide" body="Inside Dhaka in 1–2 days" />
          <Trust icon={<RotateCcw className="size-5" aria-hidden />} title="14-day returns" body="Unworn, with the receipt" />
          <Trust icon={<ShieldCheck className="size-5" aria-hidden />} title="Cash on delivery" body="Pay when it arrives" />
        </Reveal>
      </section>

      {data?.new_arrivals?.length ? (
        <Section title="New arrivals" href="/shop?sort=newest">
          <ProductGrid products={data.new_arrivals} />
        </Section>
      ) : null}

      {/* Deepest reduction first, so the row leads with what a shopper would
          call a bargain rather than the dearest thing that is marked down. */}
      {data?.price_drops?.length ? (
        <Section title="Price drops" href="/shop?sort=price-asc">
          <ProductGrid products={data.price_drops} priorityCount={0} />
        </Section>
      ) : null}

      {data?.best_sellers?.length ? (
        <Section title="Best sellers" href="/shop">
          <ProductGrid products={data.best_sellers} priorityCount={0} />
        </Section>
      ) : null}

      {data?.featured?.length ? (
        <Section title="Featured" href="/shop">
          <ProductGrid products={data.featured} priorityCount={0} />
        </Section>
      ) : null}

      {/* Featured brands have been in the home payload since this page was
          built and were never rendered, so every brand logo the API served
          pointed nowhere. They link to /brand/[slug] now. */}
      {data?.brands?.length ? (
        <Section title="Shop by brand" href="/brand">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {data.brands.map((brand) => (
              <li key={brand.slug}>
                <Link
                  href={`/brand/${brand.slug}`}
                  className={`${NAV_CARD} flex h-24 flex-col items-center justify-center gap-2 p-3`}
                >
                  {brand.logo ? (
                    <Image
                      src={brand.logo}
                      alt=""
                      width={56}
                      height={32}
                      className="h-8 w-auto object-contain"
                    />
                  ) : null}
                  <span className="truncate text-caption font-medium">{brand.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!data && (
        <div className="container-rangon py-20 text-center">
          <h2 className="text-h3">The shop is warming up</h2>
          <p className="mt-2 text-muted">
            Product data could not be loaded right now. Please try again shortly.
          </p>
        </div>
      )}
    </>
  );
}

/** The "Shop by brand" card: white, bordered, a brand border on hover, a focus ring. */
const NAV_CARD =
  "rounded-xl border border-border bg-surface transition-colors duration-fast hover:border-brand-500 " +
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]";

function Section({
  title,
  href,
  children,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    // Reveal wraps the heading row only. The product grid inside staggers its
    // own cards, and nesting one reveal inside another would delay the grid
    // behind the heading's own transition for no visible benefit.
    <section className="container-rangon py-12 sm:py-16">
      <Reveal className="mb-6 flex items-end justify-between gap-4">
        <h2 className="font-display text-h2">{title}</h2>
        {href && (
          // brand-700, not brand-600: #E22D04 on the page ground is 4.36:1 and
          // fails WCAG 1.4.3; #C42503 is 5.57:1. Semibold with an arrow gives
          // it the weight of a secondary CTA, and the hidden section name
          // tells a screen reader which "View all" this one is.
          <Link
            href={href}
            className="group inline-flex shrink-0 items-center gap-1 text-body font-semibold text-brand-700 underline-offset-4 hover:underline"
          >
            View all<span className="sr-only"> {title.toLowerCase()}</span>
            <ArrowRight
              className="size-4 transition-transform duration-fast ease-rangon motion-safe:group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        )}
      </Reveal>
      {children}
    </section>
  );
}

function Trust({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600">
        {icon}
      </span>
      <div>
        <p className="text-body-sm font-semibold">{title}</p>
        <p className="text-caption text-muted">{body}</p>
      </div>
    </div>
  );
}
