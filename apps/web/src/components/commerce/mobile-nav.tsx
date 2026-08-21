"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, Heart, LogIn, Menu, Package, User, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { LogoLink } from "@/components/brand/logo";
import { Button } from "@/components/ui/primitives";
import type { NavigationNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";

/**
 * Mobile navigation drawer (spec §24).
 *
 * Not a shrunken desktop navbar: progressive disclosure, one section open at a
 * time so the list never becomes a wall, and every parent stays a real link to
 * its landing page — the chevron is a separate control with its own accessible
 * name, so tapping "Women" shops Women and tapping the chevron reveals its
 * subcategories.
 *
 * Radix Dialog supplies the focus trap, `Escape` and scroll locking.
 */
export function MobileNav({
  items,
  signedIn,
}: {
  items: NavigationNode[];
  signedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const close = () => setOpen(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
          <Menu aria-hidden />
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/40 motion-safe:animate-fade-in lg:hidden" />
        <Dialog.Content className="fixed left-0 top-0 z-50 flex h-full w-[85vw] max-w-sm flex-col bg-surface shadow-lg motion-safe:animate-slide-in-right lg:hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title asChild>
              <span>
                <LogoLink variant="full-on-light" height={28} />
              </span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close menu">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <nav aria-label="Mobile" className="flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              {items.map((item) => {
                const isOpen = expanded === item.id;
                const hasChildren = item.children.length > 0;

                return (
                  <li key={item.id}>
                    <div className="flex items-center">
                      <Link
                        href={item.url}
                        onClick={close}
                        className="flex min-h-11 flex-1 items-center gap-2 rounded-md px-3 py-3 text-body font-medium transition-colors duration-fast hover:bg-neutral-100"
                      >
                        {item.label}
                        {item.badge && (
                          <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-white">
                            {item.badge}
                          </span>
                        )}
                      </Link>

                      {hasChildren && (
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : item.id)}
                          aria-expanded={isOpen}
                          aria-controls={`mobile-nav-${item.id}`}
                          aria-label={`${isOpen ? "Hide" : "Show"} ${item.label} categories`}
                          className="grid size-11 shrink-0 place-items-center rounded-md text-neutral-500 transition-colors duration-fast hover:bg-neutral-100"
                        >
                          <ChevronDown
                            className={cn(
                              "size-4 transition-transform duration-fast ease-rangon",
                              isOpen && "rotate-180",
                            )}
                            aria-hidden
                          />
                        </button>
                      )}
                    </div>

                    {hasChildren && isOpen && (
                      <ul
                        id={`mobile-nav-${item.id}`}
                        className="ml-3 border-l border-border pl-3 motion-safe:animate-slide-up"
                      >
                        {item.children.map((child) => (
                          <li key={child.id}>
                            <Link
                              href={child.url}
                              onClick={close}
                              className="flex min-h-11 items-center rounded-md px-3 py-2 text-body-sm text-neutral-600 transition-colors duration-fast hover:bg-neutral-100"
                            >
                              {child.label}
                            </Link>
                            {child.children.length > 0 && (
                              <ul className="ml-3 border-l border-border pl-3">
                                {child.children.map((grandchild) => (
                                  <li key={grandchild.id}>
                                    <Link
                                      href={grandchild.url}
                                      onClick={close}
                                      className="flex min-h-11 items-center rounded-md px-3 py-2 text-body-sm text-neutral-500 transition-colors duration-fast hover:bg-neutral-100"
                                    >
                                      {grandchild.label}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="border-t border-border p-2">
            {(signedIn
              ? [
                  { href: "/account", label: "Your account", icon: User },
                  { href: "/account/orders", label: "Orders", icon: Package },
                  { href: "/wishlist", label: "Wishlist", icon: Heart },
                ]
              : [
                  { href: "/login", label: "Sign in", icon: LogIn },
                  { href: "/track", label: "Track an order", icon: Package },
                  { href: "/wishlist", label: "Wishlist", icon: Heart },
                ]
            ).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={close}
                className="flex min-h-11 items-center gap-2 rounded-md px-3 py-2.5 text-body-sm transition-colors duration-fast hover:bg-neutral-100"
              >
                <link.icon className="size-4 text-neutral-500" aria-hidden />
                {link.label}
              </Link>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
