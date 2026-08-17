import { ArrowRight, RotateCcw, ShieldCheck, Truck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ProductGrid } from "@/components/commerce/product-card";
import { Button } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/client";
import type { ShopProduct } from "@/lib/api/types";

interface HomePayload {
  featured_categories: { name: string; slug: string; image: string }[];
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

  return (
    <>
      {/* Hero: photography-led, concise copy, one clear CTA in brand red. */}
      <section className="relative isolate overflow-hidden bg-neutral-950">
        <div className="container-rangon grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-2 lg:py-28">
          <div className="max-w-xl">
            <p className="text-caption font-semibold uppercase tracking-[0.28em] text-brand-400">
              New season
            </p>
            <h1 className="font-display mt-4 text-[2.25rem] font-bold leading-[1.05] text-white sm:text-[3rem] lg:text-display-xl">
              Elevate your everyday
            </h1>
            <p className="mt-5 text-body-lg text-neutral-300">
              Clothing, shoes, bags and cosmetics — chosen for how Dhaka actually dresses.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/shop">
                  Shop now <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary" className="border-neutral-700 bg-transparent text-white hover:bg-neutral-800">
                <Link href="/shop?sort=newest">New arrivals</Link>
              </Button>
            </div>
          </div>

          <div className="relative hidden aspect-[4/3] overflow-hidden rounded-xl lg:block">
            {data?.new_arrivals?.[0]?.images?.[0] ? (
              <Image
                src={data.new_arrivals[0].images[0].url}
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
        <div className="container-rangon grid gap-6 py-6 sm:grid-cols-3">
          <Trust icon={<Truck className="size-5" aria-hidden />} title="Delivery nationwide" body="Inside Dhaka in 1–2 days" />
          <Trust icon={<RotateCcw className="size-5" aria-hidden />} title="14-day returns" body="Unworn, with the receipt" />
          <Trust icon={<ShieldCheck className="size-5" aria-hidden />} title="Cash on delivery" body="Pay when it arrives" />
        </div>
      </section>

      {data?.featured_categories?.length ? (
        <Section title="Shop by category">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            {data.featured_categories.map((category) => (
              <Link
                key={category.slug}
                href={`/shop?category=${category.slug}`}
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
    <section className="container-rangon py-12 sm:py-16">
      <div className="mb-6 flex items-end justify-between gap-4">
        <h2 className="font-display text-h2">{title}</h2>
        {href && (
          <Link
            href={href}
            className="shrink-0 text-body-sm font-medium text-brand-600 hover:underline"
          >
            View all
          </Link>
        )}
      </div>
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
