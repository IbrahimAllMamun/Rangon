import { cn } from "@/lib/cn";

/**
 * A site page's body, as written in the admin's rich-text editor.
 *
 * The HTML is rendered as-is because it has already been cleaned: the API
 * runs every body through an allow-list sanitiser (`content.rich_text`, nh3)
 * before storing it, and serves only what it stored. The nonce CSP would
 * refuse an inline script even if one got through. Never pass this anything
 * that did not come from `/shop/pages/`.
 */
export function RichText({
  html,
  lead = false,
  className,
}: {
  html: string;
  /** Style the opening paragraph as a standfirst. */
  lead?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("rich-text", lead && "rich-text-lead", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
