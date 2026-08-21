import Link from "next/link";

import type { NavigationNode } from "@/lib/api/types";

/**
 * What the navbar degrades to if `PrimaryNav` itself throws — plain anchors,
 * no menus, no JavaScript required. The third layer of navigation.md §6:
 * overrides -> categories -> this.
 */
export function NavFallback({ items }: { items: NavigationNode[] }) {
  return (
    <nav aria-label="Main" className="hidden lg:block">
      <ul className="flex items-center gap-1">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.url}
              className="inline-flex h-11 items-center rounded-md px-3 text-body-sm font-medium text-neutral-700 hover:text-brand-600"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
