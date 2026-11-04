import { QUIET_ZONE, code128Bars, encodeCode128 } from "@/lib/barcode/code128";

/**
 * A scannable Code 128, drawn as vector: an order number on a receipt or an
 * invoice, so the paper finds its order again when it is scanned.
 *
 * Sized in millimetres, as `BarcodeSvg` is and for its reason: a printer then
 * renders the bars at its own resolution instead of scaling a bitmap. The
 * default module is 0.25 mm -- two dots of a 203 DPI thermal printer, so every
 * bar lands on whole dots -- which puts an order number at about 47 mm with
 * its quiet zones, inside a 75 mm receipt.
 *
 * The text is printed beneath by the caller, not drawn here: the receipt sets
 * it in its own type, and a person can read it to a phone if the bars are torn.
 */
export function Code128Svg({
  value,
  moduleMm = 0.25,
  heightMm = 10,
  label,
  className,
}: {
  value: string;
  /** Width of the narrowest bar, in millimetres. */
  moduleMm?: number;
  heightMm?: number;
  /** What a screen reader says; the value itself by default. */
  label?: string;
  className?: string;
}) {
  const pattern = encodeCode128(value);
  const modules = pattern.length + QUIET_ZONE * 2;
  const height = heightMm / moduleMm;

  return (
    <svg
      className={className}
      width={`${(modules * moduleMm).toFixed(3)}mm`}
      height={`${heightMm.toFixed(3)}mm`}
      viewBox={`0 0 ${modules} ${height}`}
      role="img"
      aria-label={label ?? `Barcode ${value}`}
      shapeRendering="crispEdges"
    >
      {/* White ground: the quiet zones must be white on paper, not see-through. */}
      <rect x={0} y={0} width={modules} height={height} fill="#fff" />
      {code128Bars(pattern).map((bar) => (
        <rect
          key={bar.start}
          x={QUIET_ZONE + bar.start}
          y={0}
          width={bar.width}
          height={height}
          fill="#000"
        />
      ))}
    </svg>
  );
}

/**
 * An order number as a barcode with the number beneath it. A number that
 * cannot be drawn (every one can today: they are `RGN-POS-000123`) prints as
 * text alone, so a receipt is never held up by its barcode.
 */
export function OrderBarcode({
  number,
  moduleMm,
  heightMm,
  className,
}: {
  number: string;
  moduleMm?: number;
  heightMm?: number;
  className?: string;
}) {
  // Checked here, not caught around the element: a child throws as it
  // renders, after this function has returned.
  const drawable = canEncode(number);
  return (
    <div className={className}>
      {drawable && (
        <Code128Svg
          value={number}
          moduleMm={moduleMm}
          heightMm={heightMm}
          label={`Barcode of order ${number}`}
          className="mx-auto block"
        />
      )}
      <p className="tabular mt-0.5 text-center text-caption tracking-wider">{number}</p>
    </div>
  );
}

function canEncode(value: string): boolean {
  try {
    encodeCode128(value);
    return true;
  } catch {
    return false;
  }
}
