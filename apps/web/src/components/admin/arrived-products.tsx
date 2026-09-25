"use client";

import { Eye, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ROW_LINK_ABOVE, ROW_LINK_ROW, RowLink } from "@/components/admin/row-link";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface UnpublishedProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  published: boolean;
  variant_count: number;
  priced_variant_count: number;
  can_publish: boolean;
}

/**
 * The goods arrived and nobody can buy them yet.
 *
 * A buyer can create a product from the order that is buying it, and those are
 * created `DRAFT` with the retail price deliberately deferred — they know what
 * they are paying, not yet what they will charge (business-rules.md § 7a.6).
 * Nothing said so afterwards: the delivery was received, the draft sat there,
 * and the only way to notice was to go looking at the catalogue.
 *
 * Shown only once something has actually been received. Before that the product
 * being a draft is not a problem, it is the plan.
 *
 * Every unpublished product on the order is listed, not only the ones created
 * from it: a product someone hid last month is equally invisible to a shopper,
 * and its stock has equally just landed.
 *
 * `can_publish` comes from the API and mirrors `catalog.services.publish_product`
 * exactly, so this never offers a button the server would refuse — and never
 * hides one it would allow. A product priced entirely at zero is the refused
 * case (D75): publishing it would give the stock away.
 */
export function ArrivedProducts({
  products,
  canPublish,
}: {
  products: UnpublishedProduct[];
  canPublish: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const remaining = products.filter((product) => !done.includes(product.id));
  if (remaining.length === 0) return null;

  const ready = remaining.filter((product) => product.can_publish);
  const unpriced = remaining.filter((product) => !product.can_publish);

  async function publish(product: UnpublishedProduct) {
    setBusy(product.id);
    setError(null);
    try {
      await apiClient(`/products/${product.id}/publish/`, { method: "POST", body: {} });
      setDone((current) => [...current, product.id]);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : `Could not publish ${product.name}. Please try again.`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Arrived, but not on sale yet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="text-body-sm text-[var(--error)]">
            {error}
          </p>
        )}

        <p className="text-body-sm text-muted">
          {remaining.length} product{remaining.length === 1 ? "" : "s"} on this order{" "}
          {remaining.length === 1 ? "is" : "are"} hidden from the storefront. Stock has arrived, so
          nothing is stopping {remaining.length === 1 ? "it" : "them"} selling except this.
        </p>

        <ul className="divide-y divide-border rounded-lg border border-border">
          {remaining.map((product) => (
            <li
              key={product.id}
              className={`${ROW_LINK_ROW} flex flex-wrap items-center gap-3 px-4 py-3`}
            >
              <span className="min-w-0 flex-1">
                <RowLink
                  href={`/admin/products/${product.id}`}
                  className="block font-medium group-hover/row:text-brand-600"
                >
                  {product.name}
                </RowLink>
                <span className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Badge tone={product.status === "DRAFT" ? "warning" : "neutral"}>
                    {product.status === "DRAFT" ? "Draft" : "Hidden"}
                  </Badge>
                  <span className="text-caption text-muted">
                    {product.variant_count} variant{product.variant_count === 1 ? "" : "s"}
                  </span>
                </span>
              </span>

              {product.can_publish ? (
                canPublish && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={ROW_LINK_ABOVE}
                    onClick={() => publish(product)}
                    loading={busy === product.id}
                  >
                    <Eye className="size-4" aria-hidden />
                    Publish
                  </Button>
                )
              ) : (
                <span className="flex items-center gap-1.5 text-body-sm text-muted">
                  <TriangleAlert className="size-4 shrink-0 text-[var(--warning-text)]" aria-hidden />
                  Priced at zero —{" "}
                  <Link
                    href={`/admin/products/${product.id}`}
                    className="text-brand-600 hover:underline"
                  >
                    set a retail price
                  </Link>
                </span>
              )}
            </li>
          ))}
        </ul>

        {unpriced.length > 0 && (
          <p className="text-caption text-muted">
            A product with every variant at zero cannot be published: the storefront would sell it
            for nothing, and nothing downstream refuses a zero-priced order.
          </p>
        )}

        {canPublish && ready.length > 1 && (
          <Button
            type="button"
            onClick={async () => {
              // Sequential, so one failure does not leave the rest in an
              // unknown state — each row settles before the next is tried.
              for (const product of ready) await publish(product);
            }}
            loading={busy !== null}
          >
            <Eye className="size-4" aria-hidden />
            Publish all {ready.length}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
