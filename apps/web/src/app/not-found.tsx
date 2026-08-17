import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container-rangon grid min-h-[60vh] place-items-center py-20 text-center">
      <div>
        <p className="font-display text-display-lg text-brand-500">404</p>
        <h1 className="mt-2 text-h2">We could not find that page</h1>
        <p className="mt-2 text-body text-muted">
          The link may be out of date, or the product may no longer be available.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/"
            className="rounded-md bg-brand-500 px-5 py-2.5 text-body-sm font-semibold text-white hover:bg-brand-600"
          >
            Go to the homepage
          </Link>
          <Link
            href="/shop"
            className="rounded-md border border-neutral-300 px-5 py-2.5 text-body-sm font-semibold hover:bg-neutral-100"
          >
            Browse the shop
          </Link>
        </div>
      </div>
    </div>
  );
}
