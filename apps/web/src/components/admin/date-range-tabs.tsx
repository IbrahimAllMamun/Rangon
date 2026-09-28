import { FilterTabs } from "@/components/admin/filter-tabs";

/**
 * The date presets every dated admin screen offers.
 *
 * Kept in step with `DateRange.PRESETS` in `apps/api/reports/services.py`, which
 * is the authority: the API falls back to `30d` for anything it does not know,
 * so an option missing there silently shows thirty days under another name.
 *
 * "This month" and "Last month" are calendar months, and are not the same
 * question as "30 days" -- an owner comparing September with August cannot ask
 * a rolling window for it.
 */
export const RANGE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "90d", label: "90 days" },
  { value: "year", label: "This year" },
] as const;

export type RangeValue = (typeof RANGE_PRESETS)[number]["value"];

export const DEFAULT_RANGE: RangeValue = "30d";

/**
 * Narrow a `?range=` search param to a preset the API accepts.
 *
 * The value is interpolated into an API path, so an unchecked one could carry
 * `&` and append query parameters of its own. It also drives `aria-current`,
 * and an unknown value left every tab unmarked while the page quietly showed
 * thirty days.
 */
export function resolveRange(value: string | undefined): RangeValue {
  return RANGE_PRESETS.some((preset) => preset.value === value)
    ? (value as RangeValue)
    : DEFAULT_RANGE;
}

/** Segmented control linking to the same page with a different `?range=`. */
export function DateRangeTabs({
  basePath,
  active,
  presets = RANGE_PRESETS,
}: {
  basePath: string;
  active: string;
  presets?: readonly { value: string; label: string }[];
}) {
  return (
    <FilterTabs
      variant="segmented"
      label="Date range"
      tabs={presets.map((option) => ({
        label: option.label,
        href: `${basePath}?range=${option.value}`,
        active: active === option.value,
      }))}
    />
  );
}
