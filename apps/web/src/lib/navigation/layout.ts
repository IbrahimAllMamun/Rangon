/**
 * Client-safe navigation helpers.
 *
 * Split out from ./navigation.ts, which imports `apiServer` (and therefore
 * `next/headers`) and so can never be imported from a `"use client"` component
 * — pulling it into the browser bundle is a Next build error. `PrimaryNav`
 * needs only this piece.
 */
import type { NavigationNode } from "@/lib/api/types";

/** `AUTO` resolves from the data, never from the item's name (spec §7). */
export function resolveLayout(item: NavigationNode): "link" | "dropdown" | "mega" {
  if (item.layout === "MEGA") return "mega";
  if (item.layout === "DROPDOWN") return item.children.length ? "dropdown" : "link";
  if (!item.children.length) return "link";
  return item.children.some((child) => child.children.length) ? "mega" : "dropdown";
}
