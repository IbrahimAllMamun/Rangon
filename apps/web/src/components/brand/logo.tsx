/**
 * The only component that renders the Rangon logo.
 *
 * The mark is always the supplied asset, never HTML text (plan §57.2 / §82.15).
 * Files live in public/brand/logo/ and are the official vectors.
 *
 * Naming: `_dark` = dark wordmark, for LIGHT backgrounds.
 *         `_light` = white wordmark, for DARK backgrounds.
 *
 *   full      1107.19 × 207.01  (ratio 5.348)  — navbar, admin, POS headers
 *   vertical   908.81 × 795.83  (ratio 1.142)  — footer, splash, receipts
 *   symbol      239.46 × 206.16 (ratio 1.161)  — favicon, compact lockups
 */
import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/cn";

const FULL_RATIO = 1107.19 / 207.01;
const VERTICAL_RATIO = 908.81 / 795.83;
const SYMBOL_RATIO = 239.46 / 206.16;

export type LogoVariant =
  | "full-on-light"
  | "full-on-dark"
  | "vertical-on-light"
  | "vertical-on-dark"
  | "symbol";

const ASSETS: Record<LogoVariant, { src: string; ratio: number }> = {
  "full-on-light": { src: "/brand/logo/logo_full_dark.svg", ratio: FULL_RATIO },
  "full-on-dark": { src: "/brand/logo/logo_full_light.svg", ratio: FULL_RATIO },
  "vertical-on-light": { src: "/brand/logo/logo_vertical_dark.svg", ratio: VERTICAL_RATIO },
  "vertical-on-dark": { src: "/brand/logo/logo_vertical_light.svg", ratio: VERTICAL_RATIO },
  symbol: { src: "/brand/logo/logo.svg", ratio: SYMBOL_RATIO },
};

export function Logo({
  variant = "full-on-light",
  height = 34,
  className,
  priority,
}: {
  variant?: LogoVariant;
  /** Height in px; width is derived from the asset's own aspect ratio so the
   *  logo can never be stretched or squashed. */
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  const asset = ASSETS[variant];
  const width = Math.round(height * asset.ratio);

  return (
    <Image
      src={asset.src}
      alt="Rangon Fashion"
      width={width}
      height={height}
      priority={priority}
      // p-1 keeps the required clear space: nothing sits flush against the mark.
      className={cn("select-none p-1", className)}
      style={{ height, width: "auto" }}
    />
  );
}

export function LogoLink({
  href = "/",
  variant = "full-on-light",
  height = 34,
  className,
  priority,
}: {
  href?: string;
  variant?: LogoVariant;
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label="Rangon Fashion — home"
      className={cn("inline-flex items-center rounded-md", className)}
    >
      <Logo variant={variant} height={height} priority={priority} />
    </Link>
  );
}
