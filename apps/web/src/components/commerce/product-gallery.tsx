"use client";

import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/cn";

export function ProductGallery({
  images,
  productName,
}: {
  images: { url: string; alt: string; variant: string | null }[];
  productName: string;
}) {
  const [active, setActive] = useState(0);

  if (images.length === 0) {
    return (
      <div className="aspect-product w-full rounded-xl bg-neutral-100" role="img" aria-label={`${productName} — no image available`} />
    );
  }

  const current = images[Math.min(active, images.length - 1)];

  return (
    <div className="flex flex-col-reverse gap-4 sm:flex-row">
      {images.length > 1 && (
        <ul
          className="flex gap-3 overflow-x-auto sm:flex-col sm:overflow-visible"
          aria-label="Product images"
        >
          {images.map((image, index) => (
            <li key={`${image.url}-${index}`}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-label={`Show image ${index + 1} of ${images.length}`}
                aria-current={index === active}
                className={cn(
                  "relative size-16 shrink-0 overflow-hidden rounded-md border-2 transition-colors duration-fast sm:size-20",
                  index === active ? "border-brand-500" : "border-transparent hover:border-neutral-300",
                )}
              >
                <Image src={image.url} alt="" fill sizes="80px" className="object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative aspect-product flex-1 overflow-hidden rounded-xl bg-neutral-100">
        <Image
          key={current.url}
          src={current.url}
          alt={current.alt || productName}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover animate-fade-in"
        />
      </div>
    </div>
  );
}
