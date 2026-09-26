import { SocialIcon } from "@/components/commerce/social-icons";
import type { SiteSocialLink } from "@/lib/api/types";
import { cn } from "@/lib/cn";

/**
 * The shop's social profiles, in the order the shop chose (Admin → Footer &
 * pages → Social media). Only profiles that are ticked *and* filled in reach
 * this list; the API drops the rest.
 *
 * Each link is a 44px target (WCAG 2.5.8 asks 24) named for what it does, so a
 * screen reader hears "Rangon Fashion on Instagram, opens in a new tab"
 * rather than an unlabelled glyph.
 */
export function SocialLinks({
  links,
  brand,
  tone = "dark",
  className,
}: {
  links: SiteSocialLink[];
  brand: string;
  /** `dark` for the near-black footer, `light` for a white page. */
  tone?: "dark" | "light";
  className?: string;
}) {
  if (!links.length) return null;
  return (
    <ul aria-label={`${brand} on social media`} className={cn("flex flex-wrap gap-2", className)}>
      {links.map((link) => (
        <li key={link.platform}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer me"
            aria-label={`${brand} on ${link.label} (opens in a new tab)`}
            title={link.label}
            className={cn(
              "flex size-11 items-center justify-center rounded-full transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
              tone === "dark"
                ? "bg-neutral-900 text-neutral-300 hover:bg-neutral-800 hover:text-white"
                : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 hover:text-neutral-900",
            )}
          >
            <SocialIcon platform={link.platform} className="size-5" />
          </a>
        </li>
      ))}
    </ul>
  );
}
