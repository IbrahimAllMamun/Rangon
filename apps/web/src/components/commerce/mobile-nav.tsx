"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { LogoLink } from "@/components/brand/logo";
import { Button } from "@/components/ui/primitives";

interface NavCategory {
  name: string;
  slug: string;
  children: { name: string; slug: string }[];
}

export function MobileNav({ categories }: { categories: NavCategory[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
          <Menu aria-hidden />
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/40 animate-fade-in lg:hidden" />
        <Dialog.Content className="fixed left-0 top-0 z-50 h-full w-[85vw] max-w-sm overflow-y-auto bg-surface shadow-lg animate-slide-in-right lg:hidden">
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

          <nav aria-label="Mobile" className="p-2">
            <ul className="space-y-1">
              {categories.map((category) => (
                <li key={category.slug}>
                  <Link
                    href={`/shop?category=${category.slug}`}
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-3 py-3 text-body font-medium hover:bg-neutral-100"
                  >
                    {category.name}
                  </Link>
                  {category.children.length > 0 && (
                    <ul className="ml-3 border-l border-border pl-3">
                      {category.children.map((child) => (
                        <li key={child.slug}>
                          <Link
                            href={`/shop?category=${child.slug}`}
                            onClick={() => setOpen(false)}
                            className="block rounded-md px-3 py-2 text-body-sm text-neutral-600 hover:bg-neutral-100"
                          >
                            {child.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-4 space-y-1 border-t border-border pt-4">
              {[
                { href: "/account", label: "Your account" },
                { href: "/account/orders", label: "Orders" },
                { href: "/wishlist", label: "Wishlist" },
                { href: "/contact", label: "Contact us" },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-3 py-2.5 text-body-sm hover:bg-neutral-100"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
