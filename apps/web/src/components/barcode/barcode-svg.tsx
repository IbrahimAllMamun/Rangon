import { barRuns, toEan13 } from "@/lib/barcode/ean13";

/**
 * A scannable EAN-13, drawn as vector.
 *
 * Deliberately a plain server component with no client JavaScript: a sheet can
 * carry 65 of these, and they never change once drawn.
 *
 * Three details here exist only because a scanner needs them, and each is easy
 * to leave out without the label looking wrong:
 *
 * 1. **Quiet zones.** The standard reserves 11 empty modules to the left of the
 *    symbol and 7 to the right. A scanner uses them to find where the code
 *    begins, so a label trimmed flush to the first bar frequently will not
 *    read — and it looks perfectly fine to a person.
 * 2. **Extended guard bars.** The start, centre and end guards drop below the
 *    other bars. This is not decoration: it is the visual cue that keeps the
 *    human-readable digits from being mistaken for part of the symbol, and it
 *    is what the specification draws.
 * 3. **Physical width.** The SVG is sized in millimetres rather than pixels, so
 *    a 300 DPI printer renders the bars at 300 DPI. Sizing in pixels is how a
 *    barcode ends up a scaled bitmap with soft edges that scanners reject.
 */

/** Empty modules before the first bar, per the specification. */
const QUIET_LEFT = 11;
/** Empty modules after the last bar. */
const QUIET_RIGHT = 7;
/** Modules in the symbol itself. */
const SYMBOL = 95;
const TOTAL_MODULES = QUIET_LEFT + SYMBOL + QUIET_RIGHT;

/** Module offsets at which a guard bar starts, relative to the symbol. */
const GUARD_STARTS = new Set([0, 2, 46, 48, 92, 94]);

/**
 * Nominal module width at full size is 0.33 mm. Shrinking below about 80% of
 * that starts to cost reads on cheap scanners, so this is the default for a
 * shelf label and the caller may raise it, not silently lower it.
 */
export const DEFAULT_MODULE_MM = 0.264;

export interface BarcodeSvgProps {
  /** 12 digits (a check digit is appended) or a correct 13. */
  value: string;
  /** Width of one module in millimetres. */
  moduleMm?: number;
  /** Height of the bars in millimetres, excluding the digits below. */
  heightMm?: number;
  /** Hide the printed digits when the label has no room for them. */
  showDigits?: boolean;
  className?: string;
}

export function BarcodeSvg({
  value,
  moduleMm = DEFAULT_MODULE_MM,
  heightMm = 12,
  showDigits = true,
  className,
}: BarcodeSvgProps) {
  // Let an invalid code throw rather than rendering a symbol that scans as
  // something else — the caller decides what to show instead.
  const code = toEan13(value);
  const runs = barRuns(code);

  const digitsHeight = showDigits ? 3 : 0;
  const guardDrop = showDigits ? 2.2 : 0;
  const totalHeight = heightMm + digitsHeight;
  const widthMm = TOTAL_MODULES * moduleMm;

  return (
    <svg
      className={className}
      width={`${widthMm.toFixed(3)}mm`}
      height={`${totalHeight.toFixed(3)}mm`}
      viewBox={`0 0 ${TOTAL_MODULES} ${totalHeight / moduleMm}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Barcode ${code}`}
      shapeRendering="crispEdges"
    >
      {/*
        White ground, not transparency: the quiet zones must be white on paper,
        and a transparent SVG over a tinted label leaves them tinted too.
      */}
      <rect x={0} y={0} width={TOTAL_MODULES} height={totalHeight / moduleMm} fill="#fff" />

      {runs.map((run) => {
        const isGuard = GUARD_STARTS.has(run.start);
        const barHeight = (heightMm + (isGuard ? guardDrop : 0)) / moduleMm;
        return (
          <rect
            key={run.start}
            x={QUIET_LEFT + run.start}
            y={0}
            width={run.width}
            height={barHeight}
            fill="#000"
          />
        );
      })}

      {showDigits && (
        <g fill="#000" fontFamily="monospace" fontSize={2.6 / moduleMm}>
          {/*
            The first digit sits outside the symbol, in the left quiet zone,
            set hard against the start guard — right-aligned rather than
            placed at a fixed offset, so it stays put at any module width
            instead of drifting off toward the label's edge.
          */}
          <text x={QUIET_LEFT - 1.5} y={(heightMm + 2.6) / moduleMm} textAnchor="end">
            {code[0]}
          </text>
          <text x={QUIET_LEFT + 24} y={(heightMm + 2.6) / moduleMm} textAnchor="middle">
            {code.slice(1, 7)}
          </text>
          <text x={QUIET_LEFT + 71} y={(heightMm + 2.6) / moduleMm} textAnchor="middle">
            {code.slice(7)}
          </text>
        </g>
      )}
    </svg>
  );
}
