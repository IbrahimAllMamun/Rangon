"use client";

import { Check, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";

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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { useRouter } from "next/navigation";

export interface CategoryRow {
  id: string;
  parent: string | null;
  parent_name: string;
  name: string;
  slug: string;
  description: string;
  position: number;
  is_active: boolean;
  show_in_navigation: boolean;
  tax_rate: string | null;
  product_count?: number;
}

export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  is_active: boolean;
  is_featured: boolean;
}

export interface AttributeRow {
  id: string;
  code: string;
  name: string;
  values: { id: string; value: string; display?: string }[];
}

type FieldError = { field: string; message: string };

function toFieldErrors(caught: unknown, fallbackField: string): FieldError[] {
  if (caught instanceof ApiError) {
    const found = caught.fieldErrors();
    return found.length ? found : [{ field: fallbackField, message: caught.message }];
  }
  return [{ field: fallbackField, message: "That did not work. Please try again." }];
}

/* ------------------------------------------------------------ categories -- */

/**
 * Category create/edit.
 *
 * Two fields carry warnings rather than plain hints, because both are ways to
 * break something that is not on this screen:
 *
 *  - **Slug** is a URL. The API keeps it stable across a rename on purpose, so
 *    changing it here is a deliberate act that breaks existing links.
 *  - **VAT override** replaces the organisation rate for everything in the
 *    category, and a mixed basket takes the highest rate present.
 */
export function CategoryForm({
  editing,
  categories,
  onDone,
  onCancel,
}: {
  editing?: CategoryRow;
  categories: CategoryRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(editing?.name ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [parent, setParent] = useState(editing?.parent ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [position, setPosition] = useState(String(editing?.position ?? 0));
  const [isActive, setIsActive] = useState(editing?.is_active ?? true);
  const [inNav, setInNav] = useState(editing?.show_in_navigation ?? true);
  const [taxPercent, setTaxPercent] = useState(
    editing?.tax_rate == null ? "" : String(Number((Number(editing.tax_rate) * 100).toFixed(2))),
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  // A category cannot be its own parent or sit under its own descendant; the
  // API refuses both. Leaving them out of the picker means the refusal is
  // never the first time anybody hears about the rule.
  const descendants = collectDescendants(categories, editing?.id);
  const parentOptions = categories.filter(
    (row) => row.id !== editing?.id && !descendants.has(row.id),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!name.trim()) found.push({ field: "cat-name", message: "A category needs a name." });
    if (taxPercent !== "") {
      const parsed = Number(taxPercent);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
        found.push({ field: "cat-tax", message: "The VAT rate must be between 0 and 100%." });
      }
    }
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        parent: parent || null,
        description,
        position: Number(position) || 0,
        is_active: isActive,
        show_in_navigation: inNav,
        tax_rate: taxPercent === "" ? null : (Number(taxPercent) / 100).toFixed(4),
      };
      // Only send a slug when it was deliberately changed: the API generates
      // one on create and keeps it stable on rename.
      if (slug && slug !== editing?.slug) body.slug = slug;

      await apiClient(editing ? `/categories/${editing.id}/` : "/categories/", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      onDone();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "cat-name"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.name}` : "New category"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save the category" />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="cat-name" required error={errorFor("cat-name")}>
              <Input
                id="cat-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                invalid={Boolean(errorFor("cat-name"))}
              />
            </Field>

            <Field label="Parent" htmlFor="cat-parent" hint="Leave empty for a top-level category.">
              <Select
                id="cat-parent"
                value={parent}
                onChange={(event) => setParent(event.target.value)}
              >
                <option value="">— none —</option>
                {parentOptions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.parent_name ? `${row.parent_name} / ${row.name}` : row.name}
                  </option>
                ))}
              </Select>
            </Field>

            {editing && (
              <Field
                label="URL slug"
                htmlFor="cat-slug"
                hint="Renaming keeps the old slug. Change this only when you mean to change the URL — existing links to the old one will break."
                error={errorFor("slug")}
              >
                <Input
                  id="cat-slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                />
              </Field>
            )}

            <Field label="Position" htmlFor="cat-position" hint="Lower sorts first.">
              <Input
                id="cat-position"
                type="number"
                min={0}
                value={position}
                onChange={(event) => setPosition(event.target.value)}
              />
            </Field>

            <Field
              label="VAT override"
              htmlFor="cat-tax"
              hint="Percent. Empty means the organisation rate. A basket takes the highest rate it contains."
              error={errorFor("cat-tax") ?? errorFor("tax_rate")}
            >
              <div className="flex items-center gap-2">
                <Input
                  id="cat-tax"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={taxPercent}
                  onChange={(event) => setTaxPercent(event.target.value)}
                  invalid={Boolean(errorFor("cat-tax") ?? errorFor("tax_rate"))}
                />
                <span aria-hidden className="text-body-sm text-muted">
                  %
                </span>
              </div>
            </Field>
          </div>

          <Field label="Description" htmlFor="cat-description">
            <Textarea
              id="cat-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox checked={inNav} onChange={(e) => setInNav(e.target.checked)} />
              Show in the storefront menu
            </label>
          </div>

          <div className="flex gap-3">
            <Button type="submit" loading={saving}>
              {editing ? "Save changes" : "Create category"}
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

/** Every id underneath `rootId`, so the parent picker cannot offer a cycle. */
function collectDescendants(rows: CategoryRow[], rootId?: string): Set<string> {
  const found = new Set<string>();
  if (!rootId) return found;
  let frontier = [rootId];
  while (frontier.length) {
    const next: string[] = [];
    for (const row of rows) {
      if (row.parent && frontier.includes(row.parent) && !found.has(row.id)) {
        found.add(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return found;
}

export function CategoryManager({
  categories,
  canManage,
}: {
  categories: CategoryRow[];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);

  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      {canManage && (creating || editing) && (
        <CategoryForm
          editing={editing ?? undefined}
          categories={categories}
          onDone={close}
          onCancel={close}
        />
      )}

      {canManage && !creating && !editing && (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> New category
        </Button>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Categories</caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Slug</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Products</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">VAT</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Menu</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {categories.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <span className="block font-medium">{row.name}</span>
                    {row.parent_name && (
                      <span className="block text-caption text-muted">under {row.parent_name}</span>
                    )}
                  </th>
                  <td className="px-4 py-2.5 font-mono text-caption text-muted">{row.slug}</td>
                  <td className="tabular px-4 py-2.5 text-right">{row.product_count ?? 0}</td>
                  <td className="tabular px-4 py-2.5 text-right text-muted">
                    {row.tax_rate == null
                      ? "—"
                      : `${Number((Number(row.tax_rate) * 100).toFixed(2))}%`}
                  </td>
                  <td className="px-4 py-2.5">
                    {row.show_in_navigation ? (
                      <Check className="size-4 text-[var(--success)]" aria-label="In the menu" />
                    ) : (
                      <X className="size-4 text-neutral-400" aria-label="Hidden from the menu" />
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={row.is_active ? "success" : "neutral"}>
                      {row.is_active ? "Active" : "Retired"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCreating(false);
                          setEditing(row);
                        }}
                        aria-label={`Edit ${row.name}`}
                      >
                        <Pencil className="size-4" aria-hidden /> Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-caption text-muted">
        A category holding products cannot be deleted — retire it instead, which keeps every order
        that references it intact.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- brands -- */

export function BrandManager({
  brands,
  canManage,
}: {
  brands: BrandRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<BrandRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [featured, setFeatured] = useState(false);
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  function open(row: BrandRow | null) {
    setEditing(row);
    setCreating(row === null);
    setName(row?.name ?? "");
    setSlug(row?.slug ?? "");
    setFeatured(row?.is_featured ?? false);
    setActive(row?.is_active ?? true);
    setErrors([]);
  }

  function close() {
    setEditing(null);
    setCreating(false);
    setErrors([]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setErrors([{ field: "brand-name", message: "A brand needs a name." }]);
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, is_featured: featured, is_active: active };
      if (slug && slug !== editing?.slug) body.slug = slug;
      await apiClient(editing ? `/brands/${editing.id}/` : "/brands/", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      close();
      router.refresh();
    } catch (caught) {
      setErrors(toFieldErrors(caught, "brand-name"));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <div className="space-y-4">
      {canManage && (creating || editing) && (
        <Card>
          <CardHeader>
            <CardTitle>{editing ? `Edit ${editing.name}` : "New brand"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} noValidate className="space-y-4">
              <ErrorSummary errors={errors} title="Could not save the brand" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="brand-name" required error={errorFor("brand-name")}>
                  <Input
                    id="brand-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    invalid={Boolean(errorFor("brand-name"))}
                  />
                </Field>
                {editing && (
                  <Field
                    label="URL slug"
                    htmlFor="brand-slug"
                    hint="Renaming keeps the old slug. Changing this breaks existing links."
                  >
                    <Input
                      id="brand-slug"
                      value={slug}
                      onChange={(event) => setSlug(event.target.value)}
                    />
                  </Field>
                )}
              </div>
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-body-sm">
                  <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Active
                </label>
                <label className="flex items-center gap-2 text-body-sm">
                  <Checkbox checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
                  Featured on the storefront
                </label>
              </div>
              <div className="flex gap-3">
                <Button type="submit" loading={saving}>
                  {editing ? "Save changes" : "Create brand"}
                </Button>
                <Button type="button" variant="secondary" onClick={close}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && !creating && !editing && (
        <Button onClick={() => open(null)}>
          <Plus className="size-4" aria-hidden /> New brand
        </Button>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Brands</caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Brand</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Slug</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Featured</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {brands.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="px-4 py-2.5 text-left font-medium">{row.name}</th>
                  <td className="px-4 py-2.5 font-mono text-caption text-muted">{row.slug}</td>
                  <td className="px-4 py-2.5">
                    {row.is_featured ? (
                      <Check className="size-4 text-[var(--success)]" aria-label="Featured" />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={row.is_active ? "success" : "neutral"}>
                      {row.is_active ? "Active" : "Retired"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => open(row)}
                        aria-label={`Edit ${row.name}`}
                      >
                        <Pencil className="size-4" aria-hidden /> Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ attributes -- */

/** Read-only: variants reference these values, so editing one rewrites history. */
export function AttributeList({ attributes }: { attributes: AttributeRow[] }) {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {attributes.map((attribute) => (
            <li key={attribute.id} className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-body-sm font-medium">{attribute.name}</span>
                <code className="text-caption text-muted">{attribute.code}</code>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {attribute.values.map((value) => (
                  <Badge key={value.id} tone="neutral">
                    {value.display || value.value}
                  </Badge>
                ))}
                {attribute.values.length === 0 && (
                  <span className="text-caption text-muted">No values yet</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-caption text-muted">
        Attributes and their values are shown here but edited on a product, where the variant matrix
        is generated from them. A value in use cannot be deleted — every variant that carries it
        would lose the label its orders were recorded against.
      </p>
    </div>
  );
}
