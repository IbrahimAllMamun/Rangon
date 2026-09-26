/**
 * Small, pure helpers for rendering the footer and contact details.
 * Safe on the server and in the browser; unit-tested in format.test.ts.
 */

/** `{year}` in the admin's copyright line becomes the current year. */
export function fillYear(text: string, now: Date = new Date()): string {
  return text.replaceAll("{year}", String(now.getFullYear()));
}

/**
 * A `tel:` link for a number as the shop typed it.
 *
 * Canonical Bangladeshi mobiles are stored without the `+` (`8801712345678`);
 * a dialler needs it to treat the country code as one.
 */
export function telHref(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, "");
  if (!compact) return "";
  if (compact.startsWith("+")) return `tel:${compact}`;
  if (compact.startsWith("880")) return `tel:+${compact}`;
  return `tel:${compact}`;
}

/** The address as lines, for an `<address>` block. Blank lines dropped. */
export function addressLines(address: string): string[] {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Whether a map URL is one the storefront will frame.
 *
 * The API only ever stores Google's embed URL, and the CSP `frame-src` only
 * allows that origin; checking here as well means a bad value renders nothing
 * rather than an iframe the browser then blocks.
 */
export function isGoogleMapEmbed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.google.com" &&
      (parsed.pathname.startsWith("/maps/embed") ||
        (parsed.pathname === "/maps" && parsed.searchParams.get("output") === "embed"))
    );
  } catch {
    return false;
  }
}
