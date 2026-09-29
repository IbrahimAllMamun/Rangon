"use client";

import { ArrowDown, ArrowUp, Check, ImageIcon, Loader2, Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { focusMoveButton, moveButtonId } from "@/components/admin/footer/move-focus";
import { errorsFrom } from "@/components/admin/footer/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorSummary,
  Input,
  Label,
} from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { standing } from "@/lib/commerce/product-standing";
import { money } from "@/lib/format";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

/** Mirrors `content.services.MAX_CAROUSEL_PRODUCTS`; the API refuses past it regardless. */
export const MAX_CAROUSEL_PRODUCTS = 24;

export interface CarouselRow {
  id: string;
  position: number;
  product: {
    id: string;
    name: string;
    slug: string;
    status: string;
    published: boolean;
    image: { url: string; alt: string } | null;
    min_price: string | null;
    max_price: string | null;
  };
  shown: boolean;
  hidden_reason: string;
}

interface FoundProduct {
  id: string;
  name: string;
  status: string;
  published: boolean;
  primary_image: { url: string; alt: string } | null;
  min_price: string | null;
  max_price: string | null;
}

type FieldError = { field: string; message: string };

function priceText(min: string | null, max: string | null): string {
  if (!min) return "No price yet";
  return min === max || !max ? money(min) : `${money(min)} – ${money(max)}`;
}

/**
 * The homepage carousel: find a product, add it, put the list in order.
 *
 * Everything saves as it happens -- each change is one click and as easy to
 * undo -- so there is no Save button to forget. Order is up/down buttons, not
 * drag and drop, so it works from a keyboard and a screen reader, and focus
 * stays on the row that moved (`move-focus`). A product that cannot show yet
 * stays in the list with the reason beside it, rather than vanishing.
 */
export function CarouselManager({
  items,
  canManage,
}: {
  items: CarouselRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(items);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundProduct[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<{ id: string; direction: "up" | "down" } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchAbort = useRef<AbortController | null>(null);

  // A refresh after an add or a removal brings the server's list back.
  useEffect(() => setRows(items), [items]);

  // After the list re-renders in its new order, put focus back on the row.
  useEffect(() => {
    if (!refocus) return;
    focusMoveButton(refocus.id, refocus.direction);
    setRefocus(null);
  }, [rows, refocus]);

  useEffect(() => () => searchAbort.current?.abort(), []);

  const inCarousel = new Set(rows.map((row) => row.product.id));
  const full = rows.length >= MAX_CAROUSEL_PRODUCTS;
  const hiddenCount = rows.filter((row) => !row.shown).length;

  const [queueSearch, cancelSearch] = useDebouncedCallback((term: string) => void search(term), 250);

  async function search(term: string) {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    try {
      const data = await apiClient<{ results: FoundProduct[] }>(
        `/products/?search=${encodeURIComponent(term)}&page_size=8`,
        { signal: controller.signal },
      );
      setResults(data.results);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setResults([]);
      setErrors(errorsFrom(caught, "carousel-search", "Could not search the products."));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function onQuery(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      cancelSearch();
      searchAbort.current?.abort();
      setResults(null);
      setSearching(false);
      return;
    }
    queueSearch(value.trim());
  }

  async function add(product: FoundProduct) {
    if (busy) return;
    setBusy(product.id);
    setErrors([]);
    try {
      const row = await apiClient<CarouselRow>("/home-carousel/", {
        method: "POST",
        body: { product: product.id },
      });
      setRows((current) => [...current, row]);
      setAnnouncement(
        row.shown
          ? `${product.name} added to the carousel, at number ${rows.length + 1}.`
          : `${product.name} added. It is not shown yet: ${row.hidden_reason}`,
      );
      router.refresh();
    } catch (caught) {
      setErrors(errorsFrom(caught, "carousel-search", `Could not add ${product.name}.`));
    } finally {
      setBusy(null);
      // The Add button has turned into "In the carousel"; carry on from the box.
      searchInput.current?.focus();
    }
  }

  async function remove(row: CarouselRow) {
    if (busy) return;
    const index = rows.findIndex((entry) => entry.id === row.id);
    // Where focus goes once this row is gone: the next row, or the one before.
    const neighbour = rows[index + 1] ?? rows[index - 1] ?? null;
    setBusy(row.id);
    setErrors([]);
    try {
      await apiClient(`/home-carousel/${row.id}/`, { method: "DELETE" });
      setRows((current) => current.filter((entry) => entry.id !== row.id));
      setAnnouncement(`${row.product.name} removed from the carousel.`);
      window.setTimeout(() => {
        const next = neighbour && document.getElementById(`remove-${neighbour.id}`);
        (next ?? searchInput.current ?? document.getElementById("carousel-list-heading"))?.focus();
      }, 0);
      router.refresh();
    } catch (caught) {
      setErrors(errorsFrom(caught, "carousel-list", `Could not remove ${row.product.name}.`));
    } finally {
      setBusy(null);
    }
  }

  async function move(row: CarouselRow, direction: "up" | "down") {
    // One at a time. Not by disabling the buttons: that drops focus mid-press.
    if (busy) return;
    const index = rows.findIndex((entry) => entry.id === row.id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= rows.length) return;
    setBusy(row.id);
    try {
      await apiClient(`/home-carousel/${row.id}/move/`, { method: "POST", body: { direction } });
      // Reordered here rather than by a refresh: with quick presses a refresh
      // from one move can land after the next and flick the list back.
      setRows((current) => {
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
      setAnnouncement(`${row.product.name} moved to number ${target + 1}.`);
      setRefocus({ id: row.id, direction });
    } catch (caught) {
      setErrors(errorsFrom(caught, "carousel-list", `Could not move ${row.product.name}.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ErrorSummary errors={errors} title="That did not work" />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a product</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-xl space-y-1.5">
              <Label htmlFor="carousel-search">Find a product</Label>
              <Input
                id="carousel-search"
                ref={searchInput}
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="e.g. Oxford shirt or RGN-OXF"
                aria-describedby="carousel-search-hint"
              />
              <p id="carousel-search-hint" className="text-caption text-muted">
                By name, SKU or barcode. {full
                  ? `The carousel is full at ${MAX_CAROUSEL_PRODUCTS}: remove one to add another.`
                  : `Up to ${MAX_CAROUSEL_PRODUCTS} products; each is added at the end.`}
              </p>
            </div>

            {searching && (
              <p className="flex items-center gap-2 text-body-sm text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Searching…
              </p>
            )}

            {!searching && results && results.length === 0 && (
              <p className="text-body-sm text-muted">No product matches “{query.trim()}”.</p>
            )}

            {!searching && results && results.length > 0 && (
              <ul
                aria-label="Matching products"
                className="divide-y divide-border rounded-md border border-border"
              >
                {results.map((product) => {
                  const where = standing(product);
                  const added = inCarousel.has(product.id);
                  const archived = product.status === "ARCHIVED";
                  return (
                    <li key={product.id} className="flex items-center gap-3 px-3 py-2">
                      <Thumbnail image={product.primary_image} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body-sm font-medium">{product.name}</p>
                        <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
                          <Badge tone={where.tone} title={where.title}>
                            {where.label}
                          </Badge>
                          <span className="tabular">
                            {priceText(product.min_price, product.max_price)}
                          </span>
                        </p>
                      </div>
                      {added ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-body-sm text-[var(--success-text)]">
                          <Check className="size-4" aria-hidden /> In the carousel
                        </span>
                      ) : archived ? (
                        <span className="shrink-0 text-body-sm text-muted">Archived: cannot show</span>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void add(product)}
                          loading={busy === product.id}
                          disabled={full}
                          aria-label={`Add ${product.name} to the carousel`}
                        >
                          <Plus aria-hidden /> Add
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
          You can see the carousel but not change it. Changing it needs the
          <code className="mx-1">content.navigation_manage</code> permission.
        </p>
      )}

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>
            <span id="carousel-list-heading" tabIndex={-1} className="focus:outline-none">
              In the carousel
            </span>
          </CardTitle>
          <p className="mt-0.5 text-caption text-muted">
            {rows.length} of {MAX_CAROUSEL_PRODUCTS}, shown left to right in this order.
            {hiddenCount > 0 &&
              ` ${hiddenCount} ${hiddenCount === 1 ? "is" : "are"} not on the homepage yet.`}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              title="The carousel is empty"
              description="The homepage shows no carousel until a product is added here."
            />
          ) : (
            <ol className="divide-y divide-border border-t border-border">
              {rows.map((row, index) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="tabular w-6 shrink-0 text-right text-body-sm text-muted">
                    {index + 1}
                  </span>
                  {/* No thumbnail on a phone: the name needs the width more. */}
                  <Thumbnail image={row.product.image} className="hidden sm:grid" />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/products/${row.product.id}`}
                      className="line-clamp-2 text-body-sm font-medium text-brand-700 hover:underline sm:block sm:truncate"
                    >
                      {row.product.name}
                    </Link>
                    <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
                      {row.shown ? (
                        <Badge tone="success" className="whitespace-nowrap">
                          On the homepage
                        </Badge>
                      ) : (
                        <Badge tone="warning" className="whitespace-nowrap">
                          Not shown
                        </Badge>
                      )}
                      <span className="tabular">
                        {priceText(row.product.min_price, row.product.max_price)}
                      </span>
                      {!row.shown && <span>{row.hidden_reason}</span>}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        id={moveButtonId("up", row.id)}
                        variant="ghost"
                        size="icon"
                        onClick={() => void move(row, "up")}
                        disabled={index === 0}
                        aria-label={`Move ${row.product.name} earlier`}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        id={moveButtonId("down", row.id)}
                        variant="ghost"
                        size="icon"
                        onClick={() => void move(row, "down")}
                        disabled={index === rows.length - 1}
                        aria-label={`Move ${row.product.name} later`}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      <Button
                        id={`remove-${row.id}`}
                        variant="ghost"
                        size="icon"
                        onClick={() => void remove(row)}
                        loading={busy === row.id}
                        aria-label={`Remove ${row.product.name} from the carousel`}
                        className="text-[var(--error)] hover:bg-[var(--error-bg)]"
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Thumbnail({
  image,
  className,
}: {
  image: { url: string; alt: string } | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-neutral-100 text-neutral-300",
        className,
      )}
    >
      {image ? (
        <Image src={image.url} alt="" fill sizes="48px" className="object-cover" />
      ) : (
        <ImageIcon className="size-5" aria-hidden />
      )}
    </span>
  );
}
