import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description: "Rangon Fashion — clothing, shoes, bags and cosmetics, online and in Dhaka.",
};

export default function AboutPage() {
  return (
    <article className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">About Rangon Fashion</h1>

      <p className="mt-6 text-body-lg text-neutral-700">
        Rangon Fashion is a Dhaka retailer selling clothing, shoes, bags, cosmetics and accessories —
        from our store at Panthapath and online, with the same stock behind both.
      </p>

      <p className="mt-4 text-body text-neutral-700">
        When you buy something here, the same system that runs the till in the shop reserves it for
        you. That is why the availability you see is what is actually on the shelf, and why an item
        someone buys at the counter disappears from the website within seconds.
      </p>

      <h2 className="mt-10 text-h3">What we sell</h2>
      <p className="mt-3 text-body text-neutral-700">
        Everyday menswear and womenswear, kidswear, footwear, bags and cosmetics — chosen for Dhaka’s
        climate and how people here actually dress, not for a catalogue photograph.
      </p>

      <h2 className="mt-10 text-h3">Visit us</h2>
      <p className="mt-3 text-body text-neutral-700">
        Level 3, Bashundhara City, Panthapath, Dhaka 1215. Saturday to Thursday, 10:00–20:00.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/shop"
          className="rounded-md bg-brand-500 px-5 py-2.5 text-body-sm font-semibold text-white hover:bg-brand-600"
        >
          Browse the shop
        </Link>
        <Link
          href="/contact"
          className="rounded-md border border-neutral-300 px-5 py-2.5 text-body-sm font-semibold hover:bg-neutral-100"
        >
          Contact us
        </Link>
      </div>
    </article>
  );
}
