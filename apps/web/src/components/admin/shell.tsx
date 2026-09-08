"use client";

import {
  ArrowRightLeft,
  BarChart3,
  Boxes,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Compass,
  Factory,
  FolderTree,
  Landmark,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Star,
  Ticket,
  Truck,
  Undo2,
  UserCog,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { NotificationBell } from "@/components/admin/notification-bell";
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

interface NavGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

/** Always visible above the groups — the one destination that is not a section. */
const DASHBOARD: NavItem = {
  href: "/admin",
  label: "Dashboard",
  icon: LayoutDashboard,
  permission: "reports.view",
};

/**
 * The back office grouped by the job being done, not by the table behind it.
 *
 * Eighteen flat links made every screen equally prominent and buried the three
 * inventory tools — stock counts and transfers had no nav entry at all and were
 * reachable only from buttons on the inventory page. A group is hidden entirely
 * when the signed-in role can see none of its children.
 */
const GROUPS: NavGroup[] = [
  {
    id: "sales",
    label: "Sales",
    icon: ShoppingCart,
    items: [
      { href: "/admin/orders", label: "Orders", icon: ShoppingCart, permission: "orders.view" },
      { href: "/admin/returns", label: "Returns", icon: Undo2, permission: "orders.view" },
      {
        href: "/admin/customers",
        label: "Customers",
        icon: Users,
        permission: "customers.view",
      },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    icon: Package,
    items: [
      { href: "/admin/products", label: "Products", icon: Package, permission: "products.view" },
      {
        href: "/admin/taxonomy",
        label: "Categories",
        icon: FolderTree,
        permission: "products.view",
      },
      {
        href: "/admin/reviews",
        label: "Reviews",
        icon: Star,
        permission: "content.review_moderate",
      },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: Boxes,
    items: [
      {
        href: "/admin/inventory",
        label: "Stock on hand",
        icon: Boxes,
        permission: "inventory.view",
      },
      {
        href: "/admin/inventory/counts",
        label: "Stock counts",
        icon: ClipboardCheck,
        permission: "inventory.view",
      },
      {
        href: "/admin/inventory/transfers",
        label: "Transfers",
        icon: ArrowRightLeft,
        permission: "inventory.view",
      },
    ],
  },
  {
    id: "purchasing",
    label: "Purchasing",
    icon: ClipboardList,
    items: [
      {
        href: "/admin/purchases",
        label: "Purchase orders",
        icon: ClipboardList,
        permission: "purchases.view",
      },
      {
        href: "/admin/suppliers",
        label: "Suppliers",
        icon: Factory,
        permission: "purchases.view",
      },
    ],
  },
  {
    id: "money",
    label: "Finance",
    icon: Landmark,
    items: [
      { href: "/admin/finance", label: "Accounts", icon: Landmark, permission: "finance.view" },
      { href: "/admin/expenses", label: "Expenses", icon: Receipt, permission: "finance.view" },
      { href: "/admin/reports", label: "Reports", icon: BarChart3, permission: "reports.view" },
    ],
  },
  {
    id: "storefront",
    label: "Storefront",
    icon: Megaphone,
    items: [
      {
        href: "/admin/coupons",
        label: "Coupons",
        icon: Ticket,
        permission: "content.coupons_manage",
      },
      {
        href: "/admin/navigation",
        label: "Navigation",
        icon: Compass,
        permission: "content.navigation_manage",
      },
      { href: "/admin/shipping", label: "Shipping", icon: Truck, permission: "settings.view" },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    icon: Settings,
    items: [
      { href: "/admin/staff", label: "Staff", icon: UserCog, permission: "users.view" },
      { href: "/admin/settings", label: "Settings", icon: Settings, permission: "settings.view" },
    ],
  },
];

/**
 * Longest matching href wins, so `/admin/inventory/counts` lights up "Stock
 * counts" rather than its parent "Stock on hand". A plain `startsWith` marked
 * both.
 */
function activeHrefFor(pathname: string, hrefs: string[]): string | null {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

export function AdminShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Only the groups the user has actually clicked. Everything else falls back to
  // "open if it holds the current page", so the sidebar always shows where you
  // are without remembering anything.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const can = (permission?: string) =>
    !permission || user.permissions.includes("*") || user.permissions.includes(permission);

  const groups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.permission)),
  })).filter((group) => group.items.length > 0);

  const activeHref = activeHrefFor(pathname, [
    DASHBOARD.href,
    ...groups.flatMap((group) => group.items.map((item) => item.href)),
  ]);
  const activeGroupId =
    groups.find((group) => group.items.some((item) => item.href === activeHref))?.id ?? null;
  const isExpanded = (id: string) => toggled[id] ?? id === activeGroupId;

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

        <nav
          aria-label="Admin"
          className="max-h-[calc(100vh-4rem)] space-y-1 overflow-y-auto p-3"
        >
          {can(DASHBOARD.permission) && (
            <NavLink
              item={DASHBOARD}
              active={activeHref === DASHBOARD.href}
              onNavigate={() => setOpen(false)}
            />
          )}

          {groups.map((group) => {
            const expanded = isExpanded(group.id);
            const holdsActive = group.items.some((item) => item.href === activeHref);
            const GroupIcon = group.icon;
            const panelId = `admin-nav-${group.id}`;

            return (
              <div key={group.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => setToggled((prev) => ({ ...prev, [group.id]: !expanded }))}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium",
                    "text-neutral-300 transition-colors duration-fast hover:bg-neutral-800 hover:text-white",
                    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
                  )}
                >
                  <GroupIcon className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1 text-left">{group.label}</span>
                  {/* A collapsed section still has to say it holds the current
                      page, or closing it loses your place entirely. */}
                  {holdsActive && !expanded && (
                    <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                  )}
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 text-neutral-500 transition-transform duration-fast",
                      "motion-reduce:transition-none",
                      expanded && "rotate-90",
                    )}
                  />
                </button>

                {/* Kept mounted but `hidden`, so `aria-controls` always resolves
                    and the collapsed links stay out of the tab order. */}
                <ul id={panelId} hidden={!expanded} className="ml-5 border-l border-neutral-800 pl-2">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <NavLink
                        item={item}
                        active={activeHref === item.href}
                        onNavigate={() => setOpen(false)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

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
            {/* Staff alerts: low stock, new online orders, returns (D3). */}
            <NotificationBell />
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

/**
 * One destination. Brand red marks the current page and nothing else in the
 * panel — CLAUDE.md §10 keeps red for action, emphasis and identity.
 */
function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium",
        "transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
        active
          ? "bg-brand-500 text-white"
          : "text-neutral-300 hover:bg-neutral-800 hover:text-white",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {item.label}
    </Link>
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
