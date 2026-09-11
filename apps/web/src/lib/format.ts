/**
 * Display formatting. Currency is configuration, not a literal — the backend
 * sends money as a *string* so no float rounding happens on the way in.
 */

const CURRENCY_SYMBOL = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL ?? "৳";

/**
 * The shop's timezone, and the only one any timestamp is ever shown in.
 *
 * Must match `DJANGO_TIME_ZONE`: the API decides what "today" means in this
 * zone, so a page that renders the answer in another one contradicts it.
 * Without it `toLocaleDateString` uses whatever the runtime sits in -- UTC in
 * the server container, the visitor's own zone in the browser -- so the same
 * instant rendered as two different dates depending on where the component ran,
 * and anything between midnight and 06:00 Dhaka displayed as the previous day.
 * A statement for 1-31 August was headed "31 Jul 2026 to 31 Aug 2026".
 */
const SHOP_TIME_ZONE = process.env.NEXT_PUBLIC_TIME_ZONE || "Asia/Dhaka";

export function money(value: string | number | null | undefined, withSymbol = true): string {
  if (value === null || value === undefined || value === "") return withSymbol ? `${CURRENCY_SYMBOL} 0.00` : "0.00";
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (Number.isNaN(amount)) return withSymbol ? `${CURRENCY_SYMBOL} 0.00` : "0.00";
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withSymbol ? `${CURRENCY_SYMBOL} ${formatted}` : formatted;
}

/** Whole-taka display for compact places like KPI tiles. */
export function moneyCompact(value: string | number | null | undefined): string {
  const amount = typeof value === "string" ? Number.parseFloat(value ?? "0") : (value ?? 0);
  if (Number.isNaN(amount)) return `${CURRENCY_SYMBOL} 0`;
  if (Math.abs(amount) >= 100000)
    return `${CURRENCY_SYMBOL} ${(amount / 100000).toFixed(2)}L`; // lakh, as Bangladesh reads it
  if (Math.abs(amount) >= 1000) return `${CURRENCY_SYMBOL} ${(amount / 1000).toFixed(1)}k`;
  return `${CURRENCY_SYMBOL} ${amount.toFixed(0)}`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SHOP_TIME_ZONE,
  });
}

export function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: SHOP_TIME_ZONE,
  });
}

/**
 * Format a date-only string (`YYYY-MM-DD`) that is already a calendar date.
 *
 * `new Date("2026-08-01")` is midnight **UTC**, so rendering it in any zone
 * behind UTC gives 31 July. These values come from `TruncDate` and are days,
 * not instants -- they carry no time to convert -- so they are formatted back
 * in UTC, which returns the same date they arrived as, in every timezone.
 */
export function calendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" },
): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return dateOnly(date);
}

export function percent(value: string | number | null | undefined, digits = 1): string {
  // Nothing to show reads as a plain "0%", not "0.0%" -- same as an unparseable value.
  if (value === null || value === undefined) return "0%";
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (Number.isNaN(amount)) return "0%";
  return `${amount.toFixed(digits)}%`;
}

/** Human label for an enum value: RETURN_REQUESTED -> "Return requested". */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const lower = value.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
