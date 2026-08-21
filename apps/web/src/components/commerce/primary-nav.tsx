"use client";

import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { ChevronDown } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import type { NavigationNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { resolveLayout } from "@/lib/navigation/layout";

/**
 * Desktop primary navigation (ADR-0010).
 *
 * Radix supplies `aria-expanded`, `aria-controls`, roving focus, `Escape` and
 * focus return. What is added on top:
 *
 *  - **every menu parent is a real link** to its landing page, so nothing is
 *    reachable by hover alone. Radix's trigger is normally a `<button>`; with
 *    `asChild` it becomes the anchor and keeps the ARIA wiring.
 *  - because Enter on an anchor navigates rather than opening, `ArrowDown`
 *    opens the panel explicitly. Without it a keyboard user could reach the
 *    landing page but never the submenu.
 *  - the panel repeats the landing page as its first row, so the destination is
 *    always one predictable tab stop inside the menu too.
 *
 * There is no `WomenMegaMenu`: the layout is derived from the data
 * (docs/architecture/navigation.md §4).
 */
export function PrimaryNav({ items }: { items: NavigationNode[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState("");

  return (
    <NavigationMenu.Root
      value={open}
      onValueChange={setOpen}
      delayDuration={120}
      skipDelayDuration={300}
      className="hidden lg:block"
      aria-label="Main"
    >
      <NavigationMenu.List className="flex items-center gap-0.5">
        {items.map((item) => {
          const kind = resolveLayout(item);
          const active = isActive(pathname, item);

          if (kind === "link") {
            return (
              // A plain `<Link>`, not `NavigationMenu.Link` — see the note on
              // `PanelLink` below for why.
              <NavigationMenu.Item key={item.id} value={item.id}>
                <Link
                  href={item.url}
                  aria-current={active ? "page" : undefined}
                  className={triggerClass(active)}
                >
                  {item.label}
                  <NavBadge badge={item.badge} />
                </Link>
              </NavigationMenu.Item>
            );
          }

          return (
            <NavigationMenu.Item key={item.id} value={item.id} className="relative">
              {/* A plain disclosure button, not `asChild` around a `<Link>`.
                  Radix's Trigger intercepts its first activation to open the
                  panel rather than navigate — composing it with a real anchor
                  produces a confusing "click once for nothing, click again to
                  go" interaction. The panel's own "All {label}" row (below) is
                  the real, always-reachable link to the landing page, exactly
                  the pattern Radix's own examples use for a trigger with
                  children. Enter/Space/ArrowDown open it natively. */}
              <NavigationMenu.Trigger className={cn(triggerClass(active), "group")}>
                {item.label}
                <NavBadge badge={item.badge} />
                <ChevronDown
                  className="size-3.5 text-neutral-400 transition-transform duration-fast ease-rangon group-data-[state=open]:rotate-180"
                  aria-hidden
                />
              </NavigationMenu.Trigger>

              <NavigationMenu.Content
                className={cn(
                  "absolute top-full z-50 mt-0 rounded-lg border border-border bg-surface p-2 shadow-lg",
                  "motion-safe:data-[state=open]:animate-slide-up",
                  kind === "mega"
                    ? "left-1/2 w-[min(84vw,64rem)] -translate-x-1/2 p-5"
                    : "left-0 w-64",
                )}
              >
                {kind === "mega" ? (
                  <MegaPanel item={item} onNavigate={() => setOpen("")} />
                ) : (
                  <DropdownPanel item={item} onNavigate={() => setOpen("")} />
                )}
              </NavigationMenu.Content>
            </NavigationMenu.Item>
          );
        })}
      </NavigationMenu.List>
    </NavigationMenu.Root>
  );
}

function DropdownPanel({
  item,
  onNavigate,
}: {
  item: NavigationNode;
  onNavigate: () => void;
}) {
  return (
    <ul>
      <li>
        <PanelLink href={item.url} onNavigate={onNavigate} className="font-semibold">
          All {item.label}
        </PanelLink>
      </li>
      {item.children.map((child) => (
        <li key={child.id}>
          <PanelLink href={child.url} onNavigate={onNavigate}>
            {child.label}
            <NavBadge badge={child.badge} />
          </PanelLink>
        </li>
      ))}
    </ul>
  );
}

function MegaPanel({
  item,
  onNavigate,
}: {
  item: NavigationNode;
  onNavigate: () => void;
}) {
  const promos = item.children.filter((child) => child.type === "PROMO");
  const columns = item.children.filter((child) => child.type !== "PROMO");

  return (
    <div className="flex gap-6">
      <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
        {columns.map((column) => (
          <div key={column.id}>
            <PanelLink href={column.url} onNavigate={onNavigate} className="font-semibold">
              {column.label}
              <NavBadge badge={column.badge} />
            </PanelLink>
            {column.children.length > 0 && (
              <ul className="mt-1">
                {column.children.map((child) => (
                  <li key={child.id}>
                    <PanelLink href={child.url} onNavigate={onNavigate} className="text-neutral-600">
                      {child.label}
                    </PanelLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {promos.length > 0 && (
        <div className="flex w-56 shrink-0 flex-col gap-4 border-l border-border pl-6">
          {promos.map((promo) => (
            <Link
              key={promo.id}
              href={promo.url || "#"}
              onClick={onNavigate}
              className="group block overflow-hidden rounded-lg"
            >
              {promo.image && (
                <span className="relative block aspect-[4/3] overflow-hidden rounded-lg bg-neutral-100">
                  <Image
                    src={promo.image}
                    alt=""
                    fill
                    sizes="224px"
                    className="object-cover transition-transform duration-slow ease-rangon group-hover:scale-105"
                  />
                </span>
              )}
              <span className="mt-2 block text-body-sm font-semibold">{promo.label}</span>
              {promo.description && (
                <span className="block text-caption text-muted">{promo.description}</span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A plain `<Link>`, not `NavigationMenu.Link`.
 *
 * Radix's `Link` composes its own `onClick` onto the anchor — dispatching a
 * synthetic "dismiss" event that closes the menu via a synchronous state
 * flush — alongside `next/link`'s own click handler, which does the actual
 * client-side navigation. The two race: the panel (and the anchor inside it)
 * can unmount mid-click, which silently swallows the navigation on both mouse
 * click and keyboard Enter. A plain anchor sidesteps the race entirely;
 * `onNavigate` closes the panel explicitly instead.
 */
function PanelLink({
  href,
  onNavigate,
  className,
  children,
}: {
  href: string;
  onNavigate: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-body-sm text-neutral-700",
        "transition-colors duration-fast hover:bg-neutral-100 hover:text-brand-600",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Badges are data. Never `if (label === "Sale")` (spec §15). */
function NavBadge({ badge }: { badge: string | null }) {
  if (!badge) return null;
  return (
    <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-white">
      {badge}
    </span>
  );
}

function triggerClass(active: boolean) {
  return cn(
    "inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-body-sm font-medium",
    "transition-colors duration-fast ease-rangon",
    "data-[state=open]:bg-neutral-100 hover:bg-neutral-100",
    active ? "text-brand-600" : "text-neutral-700 hover:text-brand-600",
  );
}

/**
 * Marks the section a shopper is inside. Compared on the path only: a filtered
 * listing (`?attr_color=black`) is still the same section.
 */
function isActive(pathname: string, item: NavigationNode): boolean {
  const target = item.url.split("?")[0];
  if (!target || target === "/") return pathname === "/";
  if (pathname === target) return true;
  return pathname.startsWith(`${target}/`);
}
