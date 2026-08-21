"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef } from "react";

import type { ShopImage } from "@/lib/api/types";
import { cn } from "@/lib/cn";

interface Group {
  key: string;
  label: string;
  swatch: string;
  images: { image: ShopImage; index: number }[];
}

/**
 * Controlled gallery: the parent owns which image is showing, because choosing
 * a colour in the buy panel has to move it (product-media.md §4).
 *
 * **Nothing is ever hidden.** Selecting a colour moves the main image and
 * scrolls the strip; it never filters the strip, so a shopper can always see
 * every photograph the product has. Groups carry a visible text label
 * ("Black — 4 photos"), so colour is never the only carrier of meaning
 * (CLAUDE.md §11).
 */
export function ProductGallery({
  images,
  productName,
  activeIndex,
  onSelect,
}: {
  images: ShopImage[];
  productName: string;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const thumbnails = useRef<(HTMLButtonElement | null)[]>([]);

  const groups = useMemo(() => groupByColour(images), [images]);

  // Keep the active thumbnail visible when the buy panel moves the selection.
  useEffect(() => {
    const target = thumbnails.current[activeIndex];
    if (!target) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeIndex]);

  if (images.length === 0) {
    return (
      <div
        className="aspect-product w-full rounded-xl bg-neutral-100"
        role="img"
        aria-label={`${productName} — no image available`}
      />
    );
  }

  const index = Math.min(Math.max(activeIndex, 0), images.length - 1);
  const current = images[index];

  return (
    <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-start">
      <div className="relative aspect-product flex-1 overflow-hidden rounded-xl bg-neutral-100">
        <Image
          key={current.url}
          src={current.url}
          alt={current.alt || productName}
          fill
          // Only the image actually on screen is priority. A product with five
          // colourways and four photos each must not fetch twenty on load.
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover motion-safe:animate-fade-in"
        />
      </div>

      {images.length > 1 && (
        <div className="sm:max-h-[32rem] sm:w-24 sm:shrink-0 sm:overflow-y-auto">
          {groups.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <p className="mb-1.5 flex items-center gap-1.5 text-caption text-muted">
                {group.swatch && (
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full border border-neutral-300"
                    style={{ backgroundColor: group.swatch }}
                  />
                )}
                <span className="truncate">
                  {group.label} — {group.images.length}{" "}
                  {group.images.length === 1 ? "photo" : "photos"}
                </span>
              </p>

              <ul
                className="flex gap-3 overflow-x-auto sm:flex-wrap sm:overflow-visible"
                aria-label={`${group.label} images`}
              >
                {group.images.map(({ image, index: imageIndex }) => (
                  <li key={`${image.url}-${imageIndex}`}>
                    <button
                      type="button"
                      ref={(node) => {
                        thumbnails.current[imageIndex] = node;
                      }}
                      onClick={() => onSelect(imageIndex)}
                      aria-label={`Show ${image.alt || productName}`}
                      aria-current={imageIndex === index}
                      className={cn(
                        "relative size-16 shrink-0 overflow-hidden rounded-md border-2 transition-colors duration-fast sm:size-20",
                        imageIndex === index
                          ? "border-brand-500"
                          : "border-transparent hover:border-neutral-300",
                      )}
                    >
                      <Image
                        src={image.url}
                        alt=""
                        fill
                        sizes="80px"
                        loading="lazy"
                        className="object-cover"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Groups in the order the images arrive, so the strip's reading order matches
 * the merchandiser's ordering rather than an alphabetical one.
 */
function groupByColour(images: ShopImage[]): Group[] {
  const groups: Group[] = [];

  images.forEach((image, index) => {
    const key = image.color?.value ?? "__shared__";
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        label: image.color?.label ?? "All colours",
        swatch: image.color?.swatch ?? "",
        images: [],
      };
      groups.push(group);
    }
    group.images.push({ image, index });
  });

  return groups;
}
