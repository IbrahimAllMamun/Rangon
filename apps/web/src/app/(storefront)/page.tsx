import { ArrowRight, RotateCcw, ShieldCheck, Truck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ProductGrid } from "@/components/commerce/product-card";
import { Button } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { apiServer } from "@/lib/api/server";
import type { ShopProduct, StorefrontBanner } from "@/lib/api/types";

interface HomePayload {
  hero: StorefrontBanner | null;
  featured_categories: { name: string; slug: string; path: string; image: string }[];
  new_arrivals: ShopProduct[];
  featured: ShopProduct[];
  best_sellers: ShopProduct[];
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
        <div className="container-rangon grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-2 lg:py-28">
          <div className="max-w-xl">
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
            <div style={{ animationDelay: "180ms" }} className="motion-safe:animate-rise-in mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={hero?.url || "/shop"}>
                  {hero?.cta_label || "Shop now"} <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary" className="border-neutral-700 bg-transparent text-white hover:bg-neutral-800">
                <Link href="/shop?sort=newest">New arrivals</Link>
              </Button>
            </div>
          </div>

          <div
            style={{ animationDelay: "120ms" }}
            className="motion-safe:animate-rise-in relative hidden aspect-[4/3] overflow-hidden rounded-xl lg:block"
          >
            {heroImage ? (
              <Image
                src={heroImage}
                alt=""
                fill
                priority
                sizes="(max-width: 1024px) 0px, 50vw"
                className="object-cover"
              />
            ) : (
              <div className="h-full w-full bg-neutral-900" />
            )}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="border-b border-border bg-surface">
        <Reveal className="container-rangon grid gap-6 py-6 sm:grid-cols-3">
          <Trust icon={<Truck className="size-5" aria-hidden />} title="Delivery nationwide" body="Inside Dhaka in 1–2 days" />
          <Trust icon={<RotateCcw className="size-5" aria-hidden />} title="14-day returns" body="Unworn, with the receipt" />
          <Trust icon={<ShieldCheck className="size-5" aria-hidden />} title="Cash on delivery" body="Pay when it arrives" />
        </Reveal>
      </section>

      {data?.featured_categories?.length ? (
        <Section title="Shop by category">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            {data.featured_categories.map((category) => (
              <Link
                key={category.slug}
                href={`/category/${category.path ?? category.slug}`}
                className="group relative aspect-square overflow-hidden rounded-xl bg-neutral-200"
              >
                {category.image && (
                  <Image
                    src={category.image}
                    alt=""
                    fill
                    sizes="(max-width: 768px) 50vw, 16vw"
                    className="object-cover transition-transform duration-slow ease-rangon group-hover:scale-105"
                  />
                )}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-neutral-950/80 to-transparent p-3 text-body-sm font-semibold text-white">
                  {category.name}
                </span>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {data?.new_arrivals?.length ? (
        <Section title="New arrivals" href="/shop?sort=newest">
          <ProductGrid products={data.new_arrivals} />
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
          <Link
            href={href}
            className="shrink-0 text-body-sm font-medium text-brand-600 hover:underline"
          >
            View all
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
