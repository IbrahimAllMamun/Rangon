import { Clock, Mail, MapPin, Phone } from "lucide-react";
import Link from "next/link";

import { LogoLink } from "@/components/brand/logo";
import { SocialLinks } from "@/components/commerce/social-links";
import type { SiteColumn, SitePayload } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatPhone } from "@/lib/phone";
import { addressLines, fillYear, telHref } from "@/lib/site/format";

/** Static strings, so Tailwind can see every class it has to generate. */
const COLUMN_GRID: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

/**
 * The storefront footer, drawn entirely from `/shop/site/` (ADR-0012).
 *
 * Brand block on the left -- logo, tagline, the full address, how to reach the
 * shop, and its social profiles -- then up to four link columns the shop
 * arranges in Admin → Footer & pages. A server component: nothing here needs
 * JavaScript in the browser.
 */
export function SiteFooter({ site }: { site: SitePayload }) {
  const { brand, map, social, columns, bottom } = site;
  const lines = addressLines(brand.address);

  return (
    <footer className="mt-16 border-t border-border bg-neutral-950 text-neutral-300">
      <div className="container-rangon grid gap-10 py-14 lg:grid-cols-12 lg:gap-8">
        <div className="space-y-5 lg:col-span-4">
          {/* Footer is near-black -> vertical lockup, white wordmark. */}
          <LogoLink variant="vertical-on-dark" height={132} />

          {brand.tagline && (
            <p className="max-w-xs text-body-sm text-neutral-400">{brand.tagline}</p>
          )}

          {(lines.length > 0 || brand.phone || brand.email || brand.opening_hours.length > 0) && (
            <ul className="space-y-3 text-body-sm">
              {lines.length > 0 && (
                <li className="flex gap-3">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-neutral-500" aria-hidden />
                  <div>
                    <span className="sr-only">Address: </span>
                    <address className="not-italic text-neutral-300">
                      {lines.map((line, index) => (
                        <span key={index} className="block">
                          {line}
                        </span>
                      ))}
                    </address>
                    {map.link_url && (
                      <a
                        href={map.link_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-neutral-400 underline underline-offset-4 hover:text-white"
                      >
                        Get directions
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                  </div>
                </li>
              )}

              {brand.phone && (
                <li className="flex gap-3">
                  <Phone className="mt-0.5 size-4 shrink-0 text-neutral-500" aria-hidden />
                  <a href={telHref(brand.phone)} className="hover:text-white">
                    <span className="sr-only">Phone: </span>
                    {formatPhone(brand.phone)}
                  </a>
                </li>
              )}

              {brand.email && (
                <li className="flex gap-3">
                  <Mail className="mt-0.5 size-4 shrink-0 text-neutral-500" aria-hidden />
                  <a href={`mailto:${brand.email}`} className="break-all hover:text-white">
                    <span className="sr-only">Email: </span>
                    {brand.email}
                  </a>
                </li>
              )}

              {brand.opening_hours.length > 0 && (
                <li className="flex gap-3">
                  <Clock className="mt-0.5 size-4 shrink-0 text-neutral-500" aria-hidden />
                  <div>
                    <span className="sr-only">Opening hours</span>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      {brand.opening_hours.map((row, index) => (
                        <div key={index} className="contents">
                          <dt className="text-neutral-400">{row.days}</dt>
                          <dd>{row.hours}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </li>
              )}
            </ul>
          )}

          <SocialLinks links={social} brand={brand.name} />
        </div>

        {columns.length > 0 && (
          <div
            className={cn(
              "grid gap-8 sm:grid-cols-2 lg:col-span-8",
              COLUMN_GRID[Math.min(columns.length, 4)],
            )}
          >
            {columns.map((column) => (
              <FooterColumn key={column.id} column={column} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800">
        {/* neutral-400, not 500: #737373 on the footer's #0A0A0A is 4.17:1. */}
        <div className="container-rangon flex flex-col gap-2 py-6 text-caption text-neutral-400 sm:flex-row sm:items-center sm:justify-between">
          <p>{fillYear(bottom.copyright)}</p>
          {bottom.note && <p>{bottom.note}</p>}
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ column }: { column: SiteColumn }) {
  const headingId = `footer-${column.id}`;
  return (
    <nav aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="text-body-sm font-semibold uppercase tracking-wide text-white"
      >
        {column.label}
      </h2>
      <ul className="mt-4 space-y-2">
        {column.links.map((link, index) => (
          <li key={`${link.url}-${index}`}>
            {link.external ? (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-body-sm text-neutral-400 hover:text-white"
              >
                {link.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <Link href={link.url} className="text-body-sm text-neutral-400 hover:text-white">
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
