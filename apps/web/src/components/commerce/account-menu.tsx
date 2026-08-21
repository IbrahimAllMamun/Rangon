"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Heart, LogOut, Package, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/cn";

/**
 * Guest and customer see different entries (spec §17); an admin never sees
 * admin navigation here — this menu is storefront-only by construction.
 *
 * `signedIn` is resolved on the server from the httpOnly cookie and passed in,
 * so the first paint is already correct and the menu never flickers from
 * "Login" to "Account" after hydration.
 */
export function AccountMenu({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="rounded-md p-2 text-neutral-700 transition-colors duration-fast hover:bg-neutral-100 data-[state=open]:bg-neutral-100"
        aria-label={signedIn ? "Your account" : "Account and sign in"}
      >
        <User className="size-5" aria-hidden />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className={cn(
            "z-50 w-56 rounded-lg border border-border bg-surface p-1.5 shadow-lg",
            "motion-safe:data-[state=open]:animate-slide-up",
          )}
        >
          {signedIn ? (
            <>
              <Item href="/account" icon={<User className="size-4" aria-hidden />}>
                My account
              </Item>
              <Item href="/account/orders" icon={<Package className="size-4" aria-hidden />}>
                Orders
              </Item>
              <Item href="/wishlist" icon={<Heart className="size-4" aria-hidden />}>
                Wishlist
              </Item>
              <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={signOut}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-body-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"
              >
                <LogOut className="size-4" aria-hidden />
                Sign out
              </DropdownMenu.Item>
            </>
          ) : (
            <>
              <Item href="/login" icon={<User className="size-4" aria-hidden />}>
                Sign in
              </Item>
              <Item href="/track" icon={<Package className="size-4" aria-hidden />}>
                Track an order
              </Item>
              <Item href="/wishlist" icon={<Heart className="size-4" aria-hidden />}>
                Wishlist
              </Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu.Item asChild>
      <Link
        href={href}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-body-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"
      >
        {icon}
        {children}
      </Link>
    </DropdownMenu.Item>
  );
}
