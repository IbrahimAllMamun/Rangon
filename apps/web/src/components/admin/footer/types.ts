import { ApiError } from "@/lib/api/client";
import type { OpeningHours } from "@/lib/api/types";

/** `GET /site-settings/` */
export interface SiteSettingsRow {
  tagline: string;
  address: string;
  phone: string;
  email: string;
  opening_hours: OpeningHours[];
  show_address: boolean;
  map_embed_url: string;
  map_link_url: string;
  copyright_text: string;
  bottom_note: string;
  whatsapp_float: boolean;
  /** What each blank contact field shows instead (Settings → Organisation). */
  fallbacks: { name: string; address: string; phone: string; email: string };
  updated_at: string;
  updated_by_name: string;
}

/** `GET /social-links/` — one row per platform, in the shop's order. */
export interface SocialLinkRow {
  id: string;
  platform: string;
  label: string;
  url: string;
  is_visible: boolean;
  position: number;
  /** A correctly shaped address for this platform, for the placeholder. */
  example: string;
}

/** `GET /site-pages/` */
export interface SitePageRow {
  id: string;
  slug: string;
  title: string;
  meta_description: string;
  body: string;
  is_published: boolean;
  is_system: boolean;
  path: string;
  created_at: string;
  updated_at: string;
  updated_by_name: string;
}

export type FooterItemType = "GROUP" | "LINK" | "PAGE" | "CATEGORY" | "CATEGORY_LIST" | "PROMO";

/** `GET /navigation-items/?placement=FOOTER` */
export interface FooterItemRow {
  id: string;
  placement: "FOOTER";
  type: FooterItemType;
  parent: string | null;
  category: string | null;
  category_name: string;
  page: string | null;
  page_title: string;
  label: string;
  display_label: string;
  url: string;
  position: number;
  is_active: boolean;
}

/**
 * The tabs of Admin → Footer & pages, as `?tab=` spells them.
 *
 * Lives here, not in `footer-admin.tsx`: a value exported from a `"use client"`
 * module reaches a server component as a client reference, not as the array,
 * so the server page could not read it.
 */
export const FOOTER_TABS = ["layout", "social", "contact", "pages"] as const;
export type FooterTab = (typeof FOOTER_TABS)[number];

export type FieldError = { field: string; message: string };

/** What a failed save shows: the API's field errors, or its sentence. */
export function errorsFrom(caught: unknown, fallbackField: string, fallback: string): FieldError[] {
  if (caught instanceof ApiError) {
    const fields = caught.fieldErrors();
    return fields.length ? fields : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: fallback }];
}
