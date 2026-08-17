import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProductBuyPanel } from "@/components/commerce/product-buy-panel";
import { ProductGallery } from "@/components/commerce/product-gallery";
import { ProductGrid } from "@/components/commerce/product-card";
import { apiServer } from "@/lib/api/client";
import type { ShopProduct } from "@/lib/api/types";
import { dateOnly } from "@/lib/format";

type Params = Promise<{ slug: string }>;

async function getProduct(slug: string): Promise<ShopProduct | null> {
  try {
    return await apiServer<ShopProduct>(`/shop/products/${slug}/`, {
      auth: false,
      revalidate: 60,
      tags: [`product:${slug}`],
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: "Product not found" };

  const image = product.images[0]?.url;
  return {
    title: product.seo_title || product.name,
    description: product.seo_description || product.short_description,
    alternates: { canonical: `/product/${product.slug}` },
    openGraph: {
      title: product.seo_title || product.name,
      description: product.seo_description || product.short_description,
      type: "website",
      images: image ? [{ url: image }] : undefined,
    },
  };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  const rating = product.reviews?.average ?? null;

  // Structured data so the product can appear as a rich result.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.short_description || product.description,
    image: product.images.map((image) => image.url),
    sku: product.variants[0]?.sku,
    brand: product.brand ? { "@type": "Brand", name: product.brand.name } : undefined,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: process.env.NEXT_PUBLIC_CURRENCY ?? "BDT",
      lowPrice: product.price_min,
      highPrice: product.price_max,
      availability: product.in_stock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    },
    aggregateRating:
      rating && product.reviews?.count
        ? { "@type": "AggregateRating", ratingValue: rating, reviewCount: product.reviews.count }
        : undefined,
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "/" },
      { "@type": "ListItem", position: 2, name: "Shop", item: "/shop" },
      {
        "@type": "ListItem",
        position: 3,
        name: product.category.name,
        item: `/shop?category=${product.category.slug}`,
      },
      { "@type": "ListItem", position: 4, name: product.name },
    ],
  };

  return (
    <div className="container-rangon py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([jsonLd, breadcrumbLd]) }}
      />

      <nav aria-label="Breadcrumb" className="mb-6 text-caption text-muted">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link href="/" className="hover:text-brand-600">
              Home
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href={`/shop?category=${product.category.slug}`} className="hover:text-brand-600">
              {product.category.name}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-neutral-900">
            {product.name}
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={product.images} productName={product.name} />
        <ProductBuyPanel product={product} />
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[2fr_1fr]">
        <section aria-labelledby="details-heading">
          <h2 id="details-heading" className="font-display text-h3">
            Details
          </h2>
          {product.description && (
            <p className="mt-3 whitespace-pre-line text-body text-neutral-700">
              {product.description}
            </p>
          )}

          <dl className="mt-6 divide-y divide-border border-y border-border">
            {product.brand && <SpecRow term="Brand" value={product.brand.name} />}
            <SpecRow term="Category" value={product.category.name} />
            {product.material && <SpecRow term="Material" value={product.material} />}
            {product.care_instructions && (
              <SpecRow term="Care" value={product.care_instructions} />
            )}
            <SpecRow term="SKU" value={product.variants.map((v) => v.sku).join(", ")} />
          </dl>
        </section>

        <aside className="space-y-6">
          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-h4">Delivery &amp; returns</h2>
            <ul className="mt-3 space-y-2 text-body-sm text-neutral-700">
              <li>Inside Dhaka: 1–2 days, ৳70 (free over ৳3,000)</li>
              <li>Outside Dhaka: 2–5 days, ৳130</li>
              <li>Cash on delivery available</li>
              <li>14-day returns on unworn items with the receipt</li>
            </ul>
          </div>
        </aside>
      </div>

      {product.reviews && product.reviews.count > 0 && (
        <section aria-labelledby="reviews-heading" className="mt-14">
          <h2 id="reviews-heading" className="font-display text-h3">
            Reviews ({product.reviews.count})
          </h2>
          <ul className="mt-6 space-y-6">
            {product.reviews.items.map((review) => (
              <li key={review.id} className="border-b border-border pb-6">
                <div className="flex items-center gap-3">
                  <Stars rating={review.rating} />
                  {review.verified && (
                    <span className="text-caption font-medium text-[var(--success)]">
                      Verified purchase
                    </span>
                  )}
                </div>
                {review.title && <h3 className="mt-2 text-body font-semibold">{review.title}</h3>}
                <p className="mt-1 text-body-sm text-neutral-700">{review.comment}</p>
                <p className="mt-2 text-caption text-muted">
                  {review.author} · {dateOnly(review.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {product.related && product.related.length > 0 && (
        <section aria-labelledby="related-heading" className="mt-14">
          <h2 id="related-heading" className="font-display mb-6 text-h3">
            You may also like
          </h2>
          <ProductGrid products={product.related} priorityCount={0} />
        </section>
      )}
    </div>
  );
}

function SpecRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-3">
      <dt className="text-body-sm text-muted">{term}</dt>
      <dd className="col-span-2 text-body-sm">{value}</dd>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={star <= rating ? "var(--brand-500)" : "var(--neutral-200)"}
          aria-hidden
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </span>
  );
}
