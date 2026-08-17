"use client";

import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";

export function SearchBar() {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    router.push(`/shop?q=${encodeURIComponent(trimmed)}`);
    setOpen(false);
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
        <div className="absolute inset-x-0 top-16 z-40 border-b border-border bg-surface p-4 shadow-md animate-slide-up">
          <form onSubmit={submit} className="container-rangon flex items-center gap-2" role="search">
            <label htmlFor="site-search" className="sr-only">
              Search products
            </label>
            <input
              id="site-search"
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for shirts, sneakers, lipstick…"
              className="h-11 flex-1 rounded-md border border-neutral-300 px-4 text-body focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-[var(--ring)]"
            />
            <Button type="submit">Search</Button>
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
        </div>
      )}
    </>
  );
}
