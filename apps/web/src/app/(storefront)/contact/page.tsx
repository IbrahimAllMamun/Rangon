import { Clock, Mail, MapPin, Phone } from "lucide-react";
import type { Metadata } from "next";

import { RichText } from "@/components/commerce/rich-text";
import { sitePageMetadata } from "@/components/commerce/site-page-view";
import { SocialLinks } from "@/components/commerce/social-links";
import { StoreMap } from "@/components/commerce/store-map";
import { Card } from "@/components/ui/primitives";
import { formatPhone } from "@/lib/phone";
import { addressLines, telHref } from "@/lib/site/format";
import { getSite, getSitePage } from "@/lib/site/site";

/**
 * Contact: the intro is the "contact" page's copy; the details, opening hours,
 * social profiles and map are the footer's (`/shop/site/`), so the two can
 * never disagree. All of it is edited in Admin → Footer & pages.
 *
 * Unlike a policy page, this one still works without its copy: the details
 * are what a shopper came for, so an unreachable page body just drops the
 * intro rather than the whole page.
 */
export function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("contact", "Contact us");
}

export default async function ContactPage() {
  const [site, page] = await Promise.all([getSite(), getSitePage("contact").catch(() => null)]);
  const { brand, map, social } = site;
  const lines = addressLines(brand.address);

  return (
    <div className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">{page?.title ?? "Contact us"}</h1>
      {page?.body ? (
        <RichText html={page.body} className="mt-2 text-muted" />
      ) : (
        <p className="mt-2 text-body text-muted">
          Questions about an order, a size, or a return? We are happy to help.
        </p>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {brand.phone && (
          <Card className="p-5">
            <Phone className="size-5 text-brand-500" aria-hidden />
            <h2 className="mt-3 text-h4">Phone</h2>
            <p className="mt-1 text-body-sm text-muted">
              <a href={telHref(brand.phone)} className="hover:text-brand-600">
                {formatPhone(brand.phone)}
              </a>
            </p>
          </Card>
        )}

        {brand.email && (
          <Card className="p-5">
            <Mail className="size-5 text-brand-500" aria-hidden />
            <h2 className="mt-3 text-h4">Email</h2>
            <p className="mt-1 break-all text-body-sm text-muted">
              <a href={`mailto:${brand.email}`} className="hover:text-brand-600">
                {brand.email}
              </a>
            </p>
          </Card>
        )}

        {lines.length > 0 && (
          <Card className="p-5">
            <MapPin className="size-5 text-brand-500" aria-hidden />
            <h2 className="mt-3 text-h4">Store</h2>
            <address className="mt-1 text-body-sm not-italic text-muted">
              {lines.map((line, index) => (
                <span key={index} className="block">
                  {line}
                </span>
              ))}
            </address>
          </Card>
        )}

        {brand.opening_hours.length > 0 && (
          <Card className="p-5">
            <Clock className="size-5 text-brand-500" aria-hidden />
            <h2 className="mt-3 text-h4">Opening hours</h2>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm text-muted">
              {brand.opening_hours.map((row, index) => (
                <div key={index} className="contents">
                  <dt>{row.days}</dt>
                  <dd>{row.hours}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
      </div>

      {social.length > 0 && (
        <section className="mt-10" aria-labelledby="contact-social">
          <h2 id="contact-social" className="text-h4">
            Message us
          </h2>
          <p className="mt-1 text-body-sm text-muted">
            We answer on social media too, usually faster than email.
          </p>
          <SocialLinks links={social} brand={brand.name} tone="light" className="mt-4" />
        </section>
      )}

      {(map.embed_url || map.link_url) && (
        <section className="mt-10" aria-labelledby="contact-map">
          <h2 id="contact-map" className="text-h4">
            Find us
          </h2>
          <div className="mt-4">
            <StoreMap
              embedUrl={map.embed_url}
              linkUrl={map.link_url}
              title={`Map showing ${brand.name}${lines[0] ? `, ${lines[0]}` : ""}`}
            />
          </div>
        </section>
      )}
    </div>
  );
}
