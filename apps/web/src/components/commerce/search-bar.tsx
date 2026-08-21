"use client";

import { Search, TrendingUp, X } from "lucide-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { useRouteTransition } from "@/lib/navigation/route-transition";

interface Suggestions {
  query: string;
  products: { name: string; slug: string; url: string; brand: string; price: string; image: string }[];
  categories: { name: string; slug: string; url: string }[];
  popular: string[];
}

const EMPTY: Suggestions = { query: "", products: [], categories: [], popular: [] };

/**
 * Search with type-ahead (spec §18).
 *
 * A combobox, not a menu: the input keeps focus, `aria-activedescendant` marks
 * the highlighted row, and Enter always falls back to a full search — so the
 * suggestions can be slow, empty or wrong without ever trapping the shopper.
 *
 * On mobile it is a full-width overlay rather than a shrunken popover.
 */
export function SearchBar() {
  const { navigate, pending } = useRouteTransition();
  const params = useSearchParams();
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [suggestions, setSuggestions] = useState<Suggestions>(EMPTY);
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = [
    ...suggestions.products.map((product) => ({ key: `p:${product.slug}`, href: product.url })),
    ...suggestions.categories.map((category) => ({
      key: `c:${category.slug}`,
      href: category.url,
    })),
    ...suggestions.popular.map((term) => ({
      key: `t:${term}`,
      href: `/shop?q=${encodeURIComponent(term)}`,
    })),
  ];

  const fetchSuggestions = useCallback(async (term: string) => {
    try {
      setSuggestions(
        await apiClient<Suggestions>(`/shop/search/suggest/?q=${encodeURIComponent(term)}`),
      );
    } catch {
      // Suggestions are a convenience; the form below still submits.
      setSuggestions(EMPTY);
    }
  }, []);

  const [debouncedFetch] = useDebouncedCallback(fetchSuggestions, 180);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlighted(-1);
    debouncedFetch(query);
  }, [open, query, debouncedFetch]);

  function go(href: string) {
    setOpen(false);
    navigate(href);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (highlighted >= 0 && rows[highlighted]) {
      go(rows[highlighted].href);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) return;
    go(`/shop?q=${encodeURIComponent(trimmed)}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!rows.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index) => (index <= 0 ? rows.length - 1 : index - 1));
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((value) => !value)}
        aria-label="Search products"
        aria-expanded={open}
      >
        <Search aria-hidden />
      </Button>

      {open && (
        <>
          {/* Click-away and a dimmed page behind the overlay. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-neutral-950/20 motion-safe:animate-fade-in"
          />

          <div className="absolute inset-x-0 top-full z-40 border-b border-border bg-surface shadow-lg motion-safe:animate-slide-up">
            <div className="container-rangon py-4">
              <form onSubmit={submit} className="flex items-center gap-2" role="search">
                <label htmlFor="site-search" className="sr-only">
                  Search products
                </label>
                <input
                  id="site-search"
                  ref={inputRef}
                  type="search"
                  role="combobox"
                  aria-expanded={rows.length > 0}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    highlighted >= 0 ? `${listId}-${rows[highlighted]?.key}` : undefined
                  }
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Search for shirts, sneakers, lipstick…"
                  className="h-11 flex-1 rounded-md border border-neutral-300 px-4 text-body focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-[var(--ring)]"
                />
                <Button type="submit" loading={pending}>
                  Search
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setOpen(false)}
                  aria-label="Close search"
                >
                  <X aria-hidden />
                </Button>
              </form>

              <div id={listId} role="listbox" aria-label="Search suggestions" className="mt-3">
                {suggestions.products.length > 0 && (
                  <Group title="Products">
                    {suggestions.products.map((product) => (
                      <Row
                        key={`p:${product.slug}`}
                        id={`${listId}-p:${product.slug}`}
                        active={rows[highlighted]?.key === `p:${product.slug}`}
                        onSelect={() => go(product.url)}
                      >
                        <span className="relative size-10 shrink-0 overflow-hidden rounded-md bg-neutral-100">
                          {product.image && (
                            <Image
                              src={product.image}
                              alt=""
                              fill
                              sizes="40px"
                              className="object-cover"
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm font-medium">
                            {product.name}
                          </span>
                          {product.brand && (
                            <span className="block text-caption text-muted">{product.brand}</span>
                          )}
                        </span>
                        <span className="tabular shrink-0 text-body-sm">{money(product.price)}</span>
                      </Row>
                    ))}
                  </Group>
                )}

                {suggestions.categories.length > 0 && (
                  <Group title="Categories">
                    {suggestions.categories.map((category) => (
                      <Row
                        key={`c:${category.slug}`}
                        id={`${listId}-c:${category.slug}`}
                        active={rows[highlighted]?.key === `c:${category.slug}`}
                        onSelect={() => go(category.url)}
                      >
                        <span className="text-body-sm">{category.name}</span>
                      </Row>
                    ))}
                  </Group>
                )}

                {suggestions.popular.length > 0 && (
                  <Group title="Popular searches">
                    {suggestions.popular.map((term) => (
                      <Row
                        key={`t:${term}`}
                        id={`${listId}-t:${term}`}
                        active={rows[highlighted]?.key === `t:${term}`}
                        onSelect={() => go(`/shop?q=${encodeURIComponent(term)}`)}
                      >
                        <TrendingUp className="size-4 text-neutral-400" aria-hidden />
                        <span className="text-body-sm">{term}</span>
                      </Row>
                    ))}
                  </Group>
                )}

                {query.trim().length >= 2 &&
                  suggestions.products.length === 0 &&
                  suggestions.categories.length === 0 && (
                    <p className="px-2 py-3 text-body-sm text-muted">
                      No suggestions. Press Enter to search everything.
                    </p>
                  )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-2 py-1 text-caption font-semibold uppercase tracking-wide text-muted">
        {title}
      </p>
      <ul>{children}</ul>
    </div>
  );
}

function Row({
  id,
  active,
  onSelect,
  children,
}: {
  id: string;
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <li id={id} role="option" aria-selected={active}>
      <button
        type="button"
        // `onMouseDown` rather than `onClick`: the input's blur would otherwise
        // close the panel before the click landed.
        onMouseDown={(event) => {
          event.preventDefault();
          onSelect();
        }}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-fast",
          active ? "bg-neutral-100" : "hover:bg-neutral-100",
        )}
      >
        {children}
      </button>
    </li>
  );
}
