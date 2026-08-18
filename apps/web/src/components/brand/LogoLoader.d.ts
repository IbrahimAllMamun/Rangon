import type { CSSProperties } from "react";

/**
 * Types for LogoLoader.jsx.
 *
 * The component is plain JSX, so TypeScript infers `className` and `style` as
 * *required* simply because they have no default value. This declaration states
 * the real contract — everything is optional — without touching the component.
 */
export interface LogoLoaderProps {
  /** Width in px; height follows the mark's own aspect ratio. */
  size?: number;
  /** Animation speed multiplier. 1 is the default cadence. */
  speed?: number;
  /** Any CSS colour, or "inherit" to take the surrounding text colour. */
  color?: string;
  /** Announced to screen readers via role="status". */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export default function LogoLoader(props: LogoLoaderProps): JSX.Element;
