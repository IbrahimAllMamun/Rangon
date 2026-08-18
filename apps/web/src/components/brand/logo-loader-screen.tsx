/**
 * Route-transition loader.
 *
 * Next renders the nearest `loading.tsx` as a Suspense fallback while a route
 * segment streams in — that *is* the page transition. This is the screen those
 * files render, so every surface shows the same brand mark drawing itself
 * instead of a generic spinner.
 *
 * LogoLoader handles `prefers-reduced-motion` itself (it swaps the trace for a
 * gentle fade), so nothing extra is needed here.
 */
import LogoLoader from "@/components/brand/LogoLoader";
import { cn } from "@/lib/cn";

export function LogoLoaderScreen({
  label = "Loading",
  size = 96,
  /** `page` fills the viewport (POS, admin). `section` fills its own area. */
  variant = "section",
  className,
}: {
  label?: string;
  size?: number;
  variant?: "page" | "section";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center",
        variant === "page" ? "min-h-screen" : "min-h-[60vh]",
        className,
      )}
    >
      {/* aria-label on the loader announces the state; the visible caption is
          decorative and hidden from screen readers to avoid saying it twice. */}
      <div className="flex flex-col items-center gap-4">
        <LogoLoader size={size} label={label} />
        <p aria-hidden className="text-caption text-muted">
          {label}…
        </p>
      </div>
    </div>
  );
}

export default LogoLoaderScreen;
