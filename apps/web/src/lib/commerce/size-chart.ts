/**
 * Size charts: the admin editor's grid logic and the product form's picker.
 *
 * A chart belongs to one Size attribute. Its **rows** are that attribute's own
 * values (so XS→XXL reads in the order set on the attribute screen, and a
 * renamed size is renamed everywhere) and its **columns** are free headings —
 * `Chest (cm)` in one chart, `UK` / `US` / `EU` in another. Each row holds one
 * cell per column, aligned by index (docs/business-rules.md §5b).
 *
 * Pure functions, no React, so the alignment rules are unit-tested rather than
 * trusted: a column added or removed must add or remove the same cell in every
 * row, or every figure after it slides under the wrong heading — which on a
 * size chart is a wrong answer that still looks right.
 *
 * The API enforces every rule here again; this only lets the editor say so
 * beside the field before the round trip.
 */

/** One chart, as `GET /size-charts/` answers. */
export interface SizeChartData {
  id: string;
  attribute: string;
  attribute_code: string;
  attribute_name: string;
  name: string;
  system: string;
  columns: string[];
  notes: string;
  position: number;
  rows: { attribute_value: string; value: string; label: string; cells: string[] }[];
  product_count: number;
}

/** One size the chart may include: a value of the chart's attribute. */
export interface SizeOption {
  id: string;
  label: string;
}

export interface DraftRow {
  valueId: string;
  label: string;
  included: boolean;
  cells: string[];
}

export interface ChartDraft {
  name: string;
  system: string;
  notes: string;
  columns: string[];
  rows: DraftRow[];
}

/** Mirrors `catalog.services` so a refusal can be shown before the save. */
export const MAX_COLUMNS = 12;
export const MAX_COLUMN_LABEL = 40;
export const MAX_CELL_LENGTH = 32;

/** Suggestions for the sizing-system field; free text is still accepted. */
export const SIZING_SYSTEMS = ["International", "UK", "EU", "US", "Asia", "Bangladesh"];

/**
 * The editor's starting state.
 *
 * Every size of the attribute gets a row, in the attribute's order, whether
 * the chart includes it or not — so including XXL later is a tick, not a
 * search. A new chart starts with every size ticked and one empty heading,
 * which is the shape most charts end up in.
 */
export function draftFromChart(chart: SizeChartData | null, sizes: SizeOption[]): ChartDraft {
  const columns = chart ? [...chart.columns] : [""];
  const stored = new Map(chart?.rows.map((row) => [row.attribute_value, row.cells]) ?? []);
  return {
    name: chart?.name ?? "",
    system: chart?.system ?? "",
    notes: chart?.notes ?? "",
    columns,
    rows: sizes.map((size) => {
      const cells = stored.get(size.id);
      return {
        valueId: size.id,
        label: size.label,
        included: chart ? cells !== undefined : true,
        cells: columns.map((_, index) => cells?.[index] ?? ""),
      };
    }),
  };
}

export function addColumn(draft: ChartDraft): ChartDraft {
  if (draft.columns.length >= MAX_COLUMNS) return draft;
  return {
    ...draft,
    columns: [...draft.columns, ""],
    rows: draft.rows.map((row) => ({ ...row, cells: [...row.cells, ""] })),
  };
}

export function removeColumn(draft: ChartDraft, index: number): ChartDraft {
  if (draft.columns.length <= 1) return draft;
  const without = <T>(items: T[]) => items.filter((_, position) => position !== index);
  return {
    ...draft,
    columns: without(draft.columns),
    rows: draft.rows.map((row) => ({ ...row, cells: without(row.cells) })),
  };
}

/** Swap a column with its neighbour, carrying every row's figure with it. */
export function moveColumn(draft: ChartDraft, index: number, direction: "left" | "right"): ChartDraft {
  const target = direction === "left" ? index - 1 : index + 1;
  if (target < 0 || target >= draft.columns.length) return draft;
  const swap = <T>(items: T[]) => {
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  };
  return {
    ...draft,
    columns: swap(draft.columns),
    rows: draft.rows.map((row) => ({ ...row, cells: swap(row.cells) })),
  };
}

export function renameColumn(draft: ChartDraft, index: number, label: string): ChartDraft {
  return { ...draft, columns: draft.columns.map((item, i) => (i === index ? label : item)) };
}

export function setCell(draft: ChartDraft, valueId: string, index: number, text: string): ChartDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) =>
      row.valueId === valueId
        ? { ...row, cells: row.cells.map((cell, i) => (i === index ? text : cell)) }
        : row,
    ),
  };
}

export function setIncluded(draft: ChartDraft, valueId: string, included: boolean): ChartDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) => (row.valueId === valueId ? { ...row, included } : row)),
  };
}

export interface ChartProblem {
  /** The id of the control the message belongs beside. */
  field: string;
  message: string;
}

/** The editor's field ids, shared with the component so errors link to them. */
export const chartFieldId = {
  name: "chart-name",
  system: "chart-system",
  notes: "chart-notes",
  column: (index: number) => `chart-column-${index}`,
  cell: (valueId: string, index: number) => `chart-cell-${valueId}-${index}`,
  include: (valueId: string) => `chart-include-${valueId}`,
};

/** The same rules `catalog.services.save_size_chart` enforces, in its words. */
export function validateChartDraft(draft: ChartDraft): ChartProblem[] {
  const problems: ChartProblem[] = [];
  if (!draft.name.trim()) {
    problems.push({ field: chartFieldId.name, message: "Give the chart a name, such as “Men's shirts”." });
  }

  const seen = new Set<string>();
  draft.columns.forEach((label, index) => {
    const text = label.trim();
    if (!text) {
      problems.push({ field: chartFieldId.column(index), message: `Column ${index + 1} needs a heading.` });
    } else if (text.length > MAX_COLUMN_LABEL) {
      problems.push({
        field: chartFieldId.column(index),
        message: `Column ${index + 1}'s heading is too long (${MAX_COLUMN_LABEL} max).`,
      });
    } else if (seen.has(text.toLocaleLowerCase())) {
      problems.push({
        field: chartFieldId.column(index),
        message: `“${text}” is there twice. Each heading must differ.`,
      });
    }
    seen.add(text.toLocaleLowerCase());
  });

  const included = draft.rows.filter((row) => row.included);
  if (included.length === 0) {
    problems.push({
      field: draft.rows[0] ? chartFieldId.include(draft.rows[0].valueId) : chartFieldId.name,
      message: "Include at least one size.",
    });
  }
  for (const row of included) {
    if (row.cells.every((cell) => !cell.trim())) {
      problems.push({
        field: chartFieldId.cell(row.valueId, 0),
        message: `${row.label} has no figures. Fill it in, or untick it.`,
      });
      continue;
    }
    const long = row.cells.findIndex((cell) => cell.trim().length > MAX_CELL_LENGTH);
    if (long >= 0) {
      problems.push({
        field: chartFieldId.cell(row.valueId, long),
        message: `A figure under ${row.label} is too long (${MAX_CELL_LENGTH} max).`,
      });
    }
  }
  return problems;
}

/** The body `POST`/`PATCH /size-charts/` takes: included rows, in the attribute's order. */
export function chartPayload(draft: ChartDraft) {
  return {
    name: draft.name.trim(),
    system: draft.system.trim(),
    notes: draft.notes.trim(),
    columns: draft.columns.map((label) => label.trim()),
    rows: draft.rows
      .filter((row) => row.included)
      .map((row) => ({ attribute_value: row.valueId, cells: row.cells.map((cell) => cell.trim()) })),
  };
}

/** A chart as the product form offers it. */
export interface SizeChartOption {
  id: string;
  name: string;
  system: string;
  attribute_code: string;
  attribute_name: string;
}

/**
 * The charts a product in this category may use.
 *
 * The same scoping as the variant axes (`resolveVariantAxes`) and the rule the
 * API enforces (`catalog.services.size_chart_problem`): a chart fits when its
 * attribute is one the category declares, or one the product's saved variants
 * are built on; a category that declares nothing offers every chart.
 *
 * The chart the product already has is always kept in the list, even when it
 * no longer fits — a select cannot show a value it has no option for, and the
 * shopkeeper needs to see what is set in order to change it.
 */
export function chartsForProduct(
  charts: SizeChartOption[],
  declared: readonly string[],
  inUse: readonly string[],
  current: string,
): SizeChartOption[] {
  if (declared.length === 0) return charts;
  const keep = new Set([...declared, ...inUse]);
  return charts.filter((chart) => keep.has(chart.attribute_code) || chart.id === current);
}

/** Charts grouped under their attribute, for an `<optgroup>` per size system. */
export function groupByAttribute(charts: SizeChartOption[]): { name: string; charts: SizeChartOption[] }[] {
  const groups = new Map<string, SizeChartOption[]>();
  for (const chart of charts) {
    groups.set(chart.attribute_name, [...(groups.get(chart.attribute_name) ?? []), chart]);
  }
  return [...groups.entries()].map(([name, grouped]) => ({ name, charts: grouped }));
}

/** "Men's shirts · UK" — the system only when there is one. */
export function chartTitle(chart: { name: string; system: string }): string {
  return chart.system ? `${chart.name} · ${chart.system}` : chart.name;
}
