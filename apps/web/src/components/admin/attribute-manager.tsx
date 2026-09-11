"use client";

/**
 * Attributes and their values, editable.
 *
 * This screen used to be read-only, on the grounds that "variants reference
 * these values, so editing one rewrites history". `OrderItem` says otherwise:
 * it snapshots `sku`, `product_name` and `variant_label` under the comment
 * "history must not move when the catalogue changes". Renaming a value is
 * therefore safe, and was withheld for a reason the schema contradicts.
 *
 * What *is* unsafe is narrower, and each case is guarded where it lives rather
 * than by disabling the whole screen:
 *
 *  - **Code** is a live filter key. `search.py` matches facets on
 *    `attribute__code`, so changing it breaks saved and shared filter URLs. The
 *    field carries the warning; it is not forbidden — same treatment as a
 *    category slug.
 *  - **Variant-defining** may be turned on freely and off only while nothing
 *    depends on it. The API refuses the rest; the control says so first.
 *  - **Deleting** anything a variant carries is refused by the database. The
 *    API turns that into a sentence, and this surfaces the sentence.
 */

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export type AttributeKind = "TEXT" | "COLOR" | "NUMBER" | "SIZE";

export interface AttributeValueRow {
  id: string;
  value: string;
  label: string;
  display?: string;
  swatch: string;
  position: number;
}

export interface AttributeRow {
  id: string;
  code: string;
  name: string;
  kind: AttributeKind;
  is_variant_defining: boolean;
  is_filterable: boolean;
  position: number;
  variant_usage?: number;
  values: AttributeValueRow[];
}

type FieldError = { field: string; message: string };

function toFieldErrors(caught: unknown, fallbackField: string): FieldError[] {
  if (caught instanceof ApiError) {
    const found = caught.fieldErrors();
    return found.length ? found : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: "That did not work. Please try again." }];
}

const KIND_LABEL: Record<AttributeKind, string> = {
  TEXT: "Text",
  COLOR: "Colour",
  NUMBER: "Number",
  SIZE: "Size",
};

/** A swatch the API will accept: `#rgb`, `#rrggbb` or `#rrggbbaa`. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/* --------------------------------------------------------- attribute form -- */

function AttributeForm({
  editing,
  onDone,
  onCancel,
}: {
  editing?: AttributeRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(editing?.name ?? "");
  const [code, setCode] = useState(editing?.code ?? "");
  const [kind, setKind] = useState<AttributeKind>(editing?.kind ?? "TEXT");
  const [variantDefining, setVariantDefining] = useState(editing?.is_variant_defining ?? true);
  const [filterable, setFilterable] = useState(editing?.is_filterable ?? true);
  const [position, setPosition] = useState(String(editing?.position ?? 0));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const usage = editing?.variant_usage ?? 0;
  // Turning it off underneath existing variants leaves rows the app can read
  // but could never have created, so the API refuses it. Say so here first.
  const lockVariantDefining = Boolean(editing) && usage > 0 && variantDefining;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!name.trim()) found.push({ field: "attr-name", message: "An attribute needs a name." });
    if (!editing && !code.trim()) {
      found.push({ field: "attr-code", message: "A code is required." });
    }
    const parsedPosition = Number(position);
    if (position !== "" && (Number.isNaN(parsedPosition) || parsedPosition < 0)) {
      found.push({ field: "attr-position", message: "Position must be zero or more." });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        is_filterable: filterable,
        position: position === "" ? 0 : parsedPosition,
      };
      if (!editing || code !== editing.code) body.code = code.trim();
      if (!lockVariantDefining) body.is_variant_defining = variantDefining;

      await apiClient(editing ? `/attributes/${editing.id}/` : "/attributes/", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      onDone();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "attr-name"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.name}` : "New attribute"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save the attribute" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="attr-name" required error={errorFor("attr-name")}>
              <Input
                id="attr-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                invalid={Boolean(errorFor("attr-name"))}
              />
            </Field>

            <Field
              label="Code"
              htmlFor="attr-code"
              required={!editing}
              error={errorFor("attr-code")}
              hint={
                editing
                  ? "The storefront filters on this. Changing it breaks saved and shared filter links."
                  : "Lowercase, no spaces — used in filter URLs and in a product import."
              }
            >
              <Input
                id="attr-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                invalid={Boolean(errorFor("attr-code"))}
              />
            </Field>

            <Field
              label="Kind"
              htmlFor="attr-kind"
              hint="Colour attributes get a colour picker on each value."
            >
              <Select
                id="attr-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as AttributeKind)}
              >
                {(Object.keys(KIND_LABEL) as AttributeKind[]).map((option) => (
                  <option key={option} value={option}>
                    {KIND_LABEL[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Position"
              htmlFor="attr-position"
              error={errorFor("attr-position")}
              hint="Lower sorts first, on the product form and in storefront filters."
            >
              <Input
                id="attr-position"
                inputMode="numeric"
                value={position}
                onChange={(event) => setPosition(event.target.value)}
                invalid={Boolean(errorFor("attr-position"))}
              />
            </Field>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={variantDefining}
                disabled={lockVariantDefining}
                onChange={(event) => setVariantDefining(event.target.checked)}
              />
              Variant-defining — generates a separate SKU per value
            </label>
            {lockVariantDefining && (
              <p className="pl-6 text-caption text-muted">
                Locked: {usage} variant{usage === 1 ? "" : "s"} exist because of this attribute.
                Those SKUs were generated on it, so it cannot stop defining them.
              </p>
            )}
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={filterable}
                onChange={(event) => setFilterable(event.target.checked)}
              />
              Filterable — shoppers can narrow the catalogue by it
            </label>
          </div>

          <div className="flex gap-3">
            <Button type="submit" loading={saving}>
              {editing ? "Save changes" : "Create attribute"}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- value form -- */

/**
 * One value of one attribute.
 *
 * A colour attribute gets a picker and a hex box side by side, wired to the
 * same state: the picker is faster, and the box is the only way to paste a
 * brand hex or to read back what was chosen. The name is always required and
 * always shown, so colour is never the only carrier of the difference
 * (CLAUDE.md §11) — a shopper who cannot distinguish two greens still reads
 * "Sage" and "Olive".
 */
function AttributeValueForm({
  attribute,
  editing,
  onDone,
  onCancel,
}: {
  attribute: AttributeRow;
  editing?: AttributeValueRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const isColour = attribute.kind === "COLOR";
  const [value, setValue] = useState(editing?.value ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [swatch, setSwatch] = useState(editing?.swatch ?? "");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  // `<input type="color">` has no empty state — it shows black when unset — so
  // the picker gets a neutral default while the stored value stays blank.
  const pickerValue = HEX.test(swatch) ? swatch.slice(0, 7) : "#888888";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!value.trim()) found.push({ field: "val-value", message: "A value needs a name." });
    if (swatch.trim() && !HEX.test(swatch.trim())) {
      found.push({
        field: "val-swatch",
        message: "Use a hex colour such as #1E3A8A, or leave it blank.",
      });
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      await apiClient(editing ? `/attribute-values/${editing.id}/` : "/attribute-values/", {
        method: editing ? "PATCH" : "POST",
        body: {
          attribute: attribute.id,
          value: value.trim(),
          label: label.trim(),
          swatch: swatch.trim().toLowerCase(),
        },
      });
      onDone();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "val-value"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4"
    >
      <ErrorSummary
        errors={errors}
        title={`Could not save this ${attribute.name.toLowerCase()} value`}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={isColour ? "Colour name" : "Value"}
          htmlFor="val-value"
          required
          error={errorFor("val-value")}
          hint={isColour ? "What a shopper reads — “Navy”, not “#1E3A8A”." : undefined}
        >
          <Input
            id="val-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            invalid={Boolean(errorFor("val-value"))}
          />
        </Field>

        <Field
          label="Display label"
          htmlFor="val-label"
          hint="Optional. Shown instead of the value where there is room."
        >
          <Input
            id="val-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
      </div>

      {isColour && (
        <Field
          label="Swatch"
          htmlFor="val-swatch"
          error={errorFor("val-swatch")}
          hint="Pick it or paste a brand hex. Leave blank for no swatch."
        >
          <div className="flex items-center gap-3">
            <input
              type="color"
              aria-label="Pick a colour"
              value={pickerValue}
              onChange={(event) => setSwatch(event.target.value)}
              className="size-10 shrink-0 cursor-pointer rounded-md border border-neutral-300 bg-white p-1"
            />
            <Input
              id="val-swatch"
              value={swatch}
              placeholder="#1E3A8A"
              spellCheck={false}
              onChange={(event) => setSwatch(event.target.value)}
              invalid={Boolean(errorFor("val-swatch"))}
              className="font-mono"
            />
            {swatch.trim() && !HEX.test(swatch.trim()) && (
              <span className="shrink-0 text-caption text-[var(--error)]">not a colour</span>
            )}
          </div>
        </Field>
      )}

      <div className="flex gap-3">
        <Button type="submit" loading={saving}>
          {editing ? "Save value" : "Add value"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- manager -- */

export function AttributeManager({
  attributes,
  canManage,
}: {
  attributes: AttributeRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [creatingAttribute, setCreatingAttribute] = useState(false);
  const [editingAttribute, setEditingAttribute] = useState<AttributeRow | null>(null);
  /** `{attributeId}` while adding, `{attributeId}:{valueId}` while editing. */
  const [valueSlot, setValueSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  // The banner sits above a list that runs to several screens, and the button
  // that triggers it can be right at the bottom — so a refusal would otherwise
  // be announced to a screen reader and invisible to everyone else. `nearest`
  // keeps the jump to the minimum that makes it readable, and `auto` respects a
  // reduced-motion preference by not animating at all.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [notice]);

  const closeAll = () => {
    setCreatingAttribute(false);
    setEditingAttribute(null);
    setValueSlot(null);
  };

  async function move(value: AttributeValueRow, direction: "up" | "down") {
    setBusy(value.id);
    setNotice(null);
    try {
      await apiClient(`/attribute-values/${value.id}/move/`, {
        method: "POST",
        body: { direction },
      });
      router.refresh();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : "Could not reorder that value.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(attribute: AttributeRow, value: AttributeValueRow) {
    const shown = value.display || value.value;
    if (!window.confirm(`Delete “${shown}” from ${attribute.name}?`)) return;
    setBusy(value.id);
    setNotice(null);
    try {
      await apiClient(`/attribute-values/${value.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      // The API explains *why* a value in use cannot go, and what to do
      // instead. Showing that beats a silent failure or a bare status code.
      setNotice(caught instanceof ApiError ? caught.message : "Could not delete that value.");
    } finally {
      setBusy(null);
    }
  }

  async function removeAttribute(attribute: AttributeRow) {
    if (!window.confirm(`Delete the ${attribute.name} attribute and all its values?`)) return;
    setBusy(attribute.id);
    setNotice(null);
    try {
      await apiClient(`/attributes/${attribute.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : "Could not delete that attribute.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div
          ref={noticeRef}
          role="alert"
          className="rounded-md border border-[var(--error)] bg-[var(--error-soft,#FEF2F2)] px-4 py-3 text-body-sm text-[var(--error)]"
        >
          {notice}
        </div>
      )}

      {canManage && (creatingAttribute || editingAttribute) && (
        <AttributeForm
          editing={editingAttribute ?? undefined}
          onDone={closeAll}
          onCancel={closeAll}
        />
      )}

      {canManage && !creatingAttribute && !editingAttribute && (
        <Button
          onClick={() => {
            closeAll();
            setCreatingAttribute(true);
          }}
        >
          <Plus className="size-4" aria-hidden /> New attribute
        </Button>
      )}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {attributes.map((attribute) => {
            const values = [...attribute.values].sort(
              (a, b) => a.position - b.position || a.value.localeCompare(b.value),
            );
            const usage = attribute.variant_usage ?? 0;

            return (
              <li key={attribute.id} className="px-4 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-body-sm font-medium">{attribute.name}</span>
                    <code className="text-caption text-muted">{attribute.code}</code>
                    <Badge tone="neutral">{KIND_LABEL[attribute.kind] ?? attribute.kind}</Badge>
                    {attribute.is_variant_defining && <Badge tone="info">Variant-defining</Badge>}
                    {!attribute.is_filterable && <Badge tone="neutral">Not filterable</Badge>}
                    {usage > 0 && (
                      <span className="text-caption text-muted">
                        {usage} variant{usage === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>

                  {canManage && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          closeAll();
                          setEditingAttribute(attribute);
                        }}
                        aria-label={`Edit the ${attribute.name} attribute`}
                      >
                        <Pencil className="size-4" aria-hidden /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === attribute.id}
                        onClick={() => removeAttribute(attribute)}
                        aria-label={`Delete the ${attribute.name} attribute`}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>

                <ul className="mt-3 space-y-1">
                  {values.map((value, index) => (
                    <li
                      key={value.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-50"
                    >
                      {attribute.kind === "COLOR" && (
                        <span
                          aria-hidden
                          className="size-5 shrink-0 rounded-full border border-neutral-300"
                          style={value.swatch ? { backgroundColor: value.swatch } : undefined}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-body-sm">
                        {value.display || value.value}
                        {value.label && value.label !== value.value && (
                          <span className="ml-2 text-caption text-muted">{value.value}</span>
                        )}
                      </span>
                      {attribute.kind === "COLOR" && (
                        <code className="shrink-0 text-caption text-muted">
                          {value.swatch || "no swatch"}
                        </code>
                      )}

                      {canManage && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={index === 0 || busy === value.id}
                            onClick={() => move(value, "up")}
                            aria-label={`Move ${value.display || value.value} up`}
                          >
                            <ArrowUp className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={index === values.length - 1 || busy === value.id}
                            onClick={() => move(value, "down")}
                            aria-label={`Move ${value.display || value.value} down`}
                          >
                            <ArrowDown className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              closeAll();
                              setValueSlot(`${attribute.id}:${value.id}`);
                            }}
                            aria-label={`Edit ${value.display || value.value}`}
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy === value.id}
                            onClick={() => remove(attribute, value)}
                            aria-label={`Delete ${value.display || value.value}`}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}

                  {values.length === 0 && (
                    <li className="px-2 text-caption text-muted">No values yet</li>
                  )}
                </ul>

                {canManage && valueSlot?.startsWith(`${attribute.id}:`) && (
                  <div className="mt-3">
                    <AttributeValueForm
                      attribute={attribute}
                      editing={values.find((row) => row.id === valueSlot.split(":")[1])}
                      onDone={closeAll}
                      onCancel={closeAll}
                    />
                  </div>
                )}

                {canManage && valueSlot === attribute.id && (
                  <div className="mt-3">
                    <AttributeValueForm
                      attribute={attribute}
                      onDone={closeAll}
                      onCancel={closeAll}
                    />
                  </div>
                )}

                {canManage && valueSlot !== attribute.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      closeAll();
                      setValueSlot(attribute.id);
                    }}
                  >
                    <Plus className="size-4" aria-hidden /> Add a value
                  </Button>
                )}
              </li>
            );
          })}

          {attributes.length === 0 && (
            <li className="px-4 py-6 text-center text-body-sm text-muted">
              No attributes yet. Create one to start building variants.
            </li>
          )}
        </ul>
      </Card>

      <p className="text-caption text-muted">
        Renaming a value is safe: every order froze its own label at the moment of sale, so history
        does not move. A value a variant carries cannot be deleted — rename it instead.
      </p>
    </div>
  );
}
