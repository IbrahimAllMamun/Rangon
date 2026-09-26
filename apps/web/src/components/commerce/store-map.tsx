import { ExternalLink } from "lucide-react";

import { isGoogleMapEmbed } from "@/lib/site/format";

/**
 * The shop on a Google map, for the Contact page.
 *
 * The URL is Google's own embed, checked by the API when it was saved and
 * again here; the CSP's `frame-src` allows that one origin and nothing else.
 * No API key and no script of ours: the iframe is Google's.
 *
 * - `loading="lazy"`: the map is below the fold on a phone and costs a lot of
 *   bytes; it loads only when scrolled near.
 * - A fixed aspect ratio reserves the space, so nothing shifts when it loads.
 * - `sandbox` still lets the map run and open "View larger map" in a new tab,
 *   but a framed page can never navigate the storefront itself.
 * - The link below it is the fallback for anyone whose browser blocks
 *   third-party frames, and the faster route on a phone with Maps installed.
 */
export function StoreMap({
  embedUrl,
  linkUrl,
  title,
}: {
  embedUrl: string;
  linkUrl: string;
  title: string;
}) {
  const embeddable = isGoogleMapEmbed(embedUrl);
  if (!embeddable && !linkUrl) return null;

  const openLink = linkUrl ? (
    <a
      href={linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-brand-700 underline-offset-4 hover:underline"
    >
      Open in Google Maps
      <ExternalLink className="size-4" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  ) : null;

  if (!embeddable) return <p>{openLink}</p>;

  return (
    <figure>
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-neutral-100 sm:aspect-[16/9]">
        <iframe
          src={embedUrl}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
      {openLink && <figcaption className="mt-3">{openLink}</figcaption>}
    </figure>
  );
}
