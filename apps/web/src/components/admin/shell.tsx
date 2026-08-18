"use client";

import {
  BarChart3,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { LogoLink } from "@/components/brand/logo";
import { PendingRegion } from "@/components/ui/pending-region";
import { Button } from "@/components/ui/primitives";
import type { SessionUser } from "@/lib/api/types";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
}

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, permission: "reports.view" },
  { href: "/admin/orders", label: "Orders", icon: ShoppingCart, permission: "orders.view" },
  { href: "/admin/products", label: "Products", icon: Package, permission: "products.view" },
  { href: "/admin/inventory", label: "Inventory", icon: Boxes, permission: "inventory.view" },
  { href: "/admin/purchases", label: "Purchases", icon: ClipboardList, permission: "purchases.view" },
  { href: "/admin/customers", label: "Customers", icon: Users, permission: "customers.view" },
  { href: "/admin/returns", label: "Returns", icon: Truck, permission: "orders.view" },
  { href: "/admin/reports", label: "Reports", icon: BarChart3, permission: "reports.view" },
  { href: "/admin/settings", label: "Settings", icon: Settings, permission: "settings.view" },
];

export function AdminShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const can = (permission?: string) =>
    !permission || user.permissions.includes("*") || user.permissions.includes(permission);
  const visible = NAV.filter((item) => can(item.permission));

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar: brand red marks the active item only, never the whole panel. */}
      <aside
        className={cn(
          "no-print fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-border bg-neutral-950 transition-transform duration-normal ease-rangon lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-neutral-800 px-4">
          {/* Sidebar is near-black -> white wordmark. */}
          <LogoLink href="/admin" variant="full-on-dark" height={26} />
          <Button
            variant="ghost"
            size="icon"
            className="text-neutral-400 lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            <X aria-hidden />
          </Button>
        </div>

        <nav aria-label="Admin" className="p-3">
          <ul className="space-y-0.5">
            {visible.map((item) => {
              const active =
                item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium transition-colors duration-fast",
                      active
                        ? "bg-brand-500 text-white"
                        : "text-neutral-300 hover:bg-neutral-800 hover:text-white",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 border-t border-neutral-800 pt-4">
            <Link
              href="/pos"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium text-neutral-300 hover:bg-neutral-800 hover:text-white"
            >
              <ShoppingCart className="size-4" />
              Open POS
            </Link>
          </div>
        </nav>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-neutral-950/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Chrome is hidden when printing an invoice or packing slip. */}
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu aria-hidden />
          </Button>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-body-sm font-medium leading-tight">{user.full_name}</p>
              <p className="text-caption text-muted">
                {user.role_name}
                {user.branch ? ` · ${user.branch.code}` : ""}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
              <LogOut aria-hidden />
            </Button>
          </div>
        </header>

        {/* Admin lists are filtered by query string — every status tab, search
            and page link re-renders this same segment, so `admin/loading.tsx`
            never fires for them. Dimming the content in place is the only
            feedback those clicks get, and it keeps the table where the eye is.
            Keyed by pathname so arriving at a new screen fades it in. */}
        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6">
          <PendingRegion key={pathname} label="Loading" className="route-fade">
            {children}
          </PendingRegion>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-h2">{title}</h1>
        {description && <p className="mt-1 text-body-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
