/**
 * Page titles, resolved in one place.
 *
 * The root layout sets `template: "%s | Rangon Fashion"`, which appends the shop
 * name to whatever a page returns. That is right until the page's own title
 * already carries it, and then the tab reads
 * "Classic Oxford Shirt | Rangon Fashion | Rangon Fashion" (D4).
 *
 * It happened because two places both believed they owned the suffix: the
 * template, and whatever wrote `seo_title`. The admin form papered over it with
 * a hint telling merchants not to type the shop name — which is a rule nobody
 * outside that form obeys, and an import or a seed certainly does not.
 *
 * So the decision moves here. A page with its own name returns an absolute
 * title, the template is bypassed, and the shop name is appended exactly once.
 */

/** Matches `openGraph.siteName` and the template in the root layout. */
export const SITE_NAME = "Rangon Fashion";

/**
 * The complete `<title>` for a page that has a name of its own.
 *
 * Checks for the shop name at the end rather than for the exact `| Rangon
 * Fashion` separator, because the spellings that reach this differ: a merchant
 * types an en dash, an importer writes a pipe, and the old seed wrote both a
 * pipe and a space. All of them end the same way.
 */
export function pageTitle(specific: string | null | undefined): { absolute: string } {
  const name = (specific ?? "").trim();
  if (!name) return { absolute: SITE_NAME };
  const alreadyNamed = name.toLowerCase().endsWith(SITE_NAME.toLowerCase());
  return { absolute: alreadyNamed ? name : `${name} | ${SITE_NAME}` };
}
