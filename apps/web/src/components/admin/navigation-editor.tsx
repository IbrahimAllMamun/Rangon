"use client";

import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface NavigationItemRow {
  id: string;
  placement: "HEADER" | "FOOTER";
  type: "CATEGORY" | "LINK" | "PROMO";
  parent: string | null;
  category: string | null;
  category_name: string;
  label: string;
  display_label: string;
  url: string;
  badge: string;
  layout: "AUTO" | "DROPDOWN" | "MEGA";
  position: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

interface Draft {
  placement: "HEADER" | "FOOTER";
  type: "CATEGORY" | "LINK" | "PROMO";
  parent: string;
  category: string;
  label: string;
  url: string;
  badge: string;
  layout: "AUTO" | "DROPDOWN" | "MEGA";
  is_active: boolean;
  starts_at: string;
  ends_at: string;
}

const BLANK: Draft = {
  placement: "HEADER",
  type: "LINK",
  parent: "",
  category: "",
  label: "",
  url: "",
  badge: "",
  layout: "AUTO",
  is_active: true,
  starts_at: "",
  ends_at: "",
};

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm", no offset.
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

function fromDraft(draft: Draft) {
  return {
    placement: draft.placement,
    type: draft.type,
    parent: draft.parent || null,
    category: draft.type === "CATEGORY" ? draft.category || null : null,
    label: draft.label,
    url: draft.type === "CATEGORY" ? "" : draft.url,
    badge: draft.badge,
    layout: draft.layout,
    is_active: draft.is_active,
    starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : null,
    ends_at: draft.ends_at ? new Date(draft.ends_at).toISOString() : null,
  };
}

function isLive(item: NavigationItemRow): boolean {
  if (!item.is_active) return false;
  const now = Date.now();
  if (item.starts_at && new Date(item.starts_at).getTime() > now) return false;
  if (item.ends_at && new Date(item.ends_at).getTime() < now) return false;
  return true;
}

/**
 * Override list for the navbar (ADR-0009).
 *
 * An empty table is not an error state here — it means the navbar is showing
 * the category tree, which is the documented default. Adding a row starts
 * overriding; deleting the last row returns to that default.
 *
 * Reordering is up/down against `move`, not drag-and-drop, so it stays
 * keyboard-operable (CLAUDE.md §11) — the same field either way.
 */
export function NavigationEditor({
  items,
  categories,
}: {
  items: NavigationItemRow[];
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<"HEADER" | "FOOTER" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);

  function startCreate(placement: "HEADER" | "FOOTER") {
    setDraft({ ...BLANK, placement });
    setCreating(placement);
    setEditing(null);
    setErrors([]);
  }

  function startEdit(item: NavigationItemRow) {
    setDraft({
      placement: item.placement,
      type: item.type,
      parent: item.parent ?? "",
      category: item.category ?? "",
      label: item.label,
      url: item.url,
      badge: item.badge,
      layout: item.layout,
      is_active: item.is_active,
      starts_at: toDatetimeLocal(item.starts_at),
      ends_at: toDatetimeLocal(item.ends_at),
    });
    setEditing(item.id);
    setCreating(null);
    setErrors([]);
  }

  function cancel() {
    setEditing(null);
    setCreating(null);
    setErrors([]);
  }

  async function save() {
    const found: { field: string; message: string }[] = [];
    if (draft.type === "CATEGORY" && !draft.category) {
      found.push({ field: "category", message: "Choose a category." });
    }
    if (draft.type !== "CATEGORY" && !draft.label.trim()) {
      found.push({ field: "label", message: "A label is required." });
    }
    if (draft.type !== "CATEGORY" && !draft.url.trim()) {
      found.push({ field: "url", message: "A URL is required." });
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      if (creating) {
        await apiClient("/navigation-items/", { method: "POST", body: fromDraft(draft) });
      } else {
        await apiClient(`/navigation-items/${editing}/`, {
          method: "PATCH",
          body: fromDraft(draft),
        });
      }
      cancel();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "label", message: caught.message }]);
      } else {
        setErrors([{ field: "label", message: "Could not save the navigation item." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: NavigationItemRow) {
    if (!window.confirm(`Remove "${item.display_label}" from navigation?`)) return;
    await apiClient(`/navigation-items/${item.id}/`, { method: "DELETE" });
    router.refresh();
  }

  async function move(item: NavigationItemRow, direction: "up" | "down") {
    setMoving(item.id);
    try {
      await apiClient(`/navigation-items/${item.id}/move/`, { method: "POST", body: { direction } });
      router.refresh();
    } finally {
      setMoving(null);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  const form = (
    <div className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4">
      <ErrorSummary errors={errors} title="Could not save this item" />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="ni-type">
          <Select
            id="ni-type"
            value={draft.type}
            onChange={(event) => setDraft({ ...draft, type: event.target.value as Draft["type"] })}
          >
            <option value="LINK">Link</option>
            <option value="CATEGORY">Category</option>
            <option value="PROMO">Promo card</option>
          </Select>
        </Field>

        <Field label="Placement" htmlFor="ni-placement">
          <Select
            id="ni-placement"
            value={draft.placement}
            onChange={(event) =>
              setDraft({ ...draft, placement: event.target.value as Draft["placement"] })
            }
          >
            <option value="HEADER">Header</option>
            <option value="FOOTER">Footer</option>
          </Select>
        </Field>

        {draft.type === "CATEGORY" ? (
          <Field
            label="Category"
            htmlFor="ni-category"
            required
            error={errorFor("category")}
            hint="The label, URL and children come from the category unless overridden below."
          >
            <Select
              id="ni-category"
              value={draft.category}
              onChange={(event) => setDraft({ ...draft, category: event.target.value })}
              invalid={Boolean(errorFor("category"))}
            >
              <option value="">Choose a category…</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="URL" htmlFor="ni-url" required error={errorFor("url")}>
            <Input
              id="ni-url"
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              placeholder="/shop?sort=newest"
              invalid={Boolean(errorFor("url"))}
            />
          </Field>
        )}

        <Field
          label="Label"
          htmlFor="ni-label"
          required={draft.type !== "CATEGORY"}
          hint={draft.type === "CATEGORY" ? "Blank uses the category's own name." : undefined}
          error={errorFor("label")}
        >
          <Input
            id="ni-label"
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            invalid={Boolean(errorFor("label"))}
          />
        </Field>

        <Field label="Badge" htmlFor="ni-badge" hint='Free text, e.g. "NEW" or "20% OFF".'>
          <Input
            id="ni-badge"
            value={draft.badge}
            onChange={(event) => setDraft({ ...draft, badge: event.target.value })}
            maxLength={24}
          />
        </Field>

        <Field label="Layout" htmlFor="ni-layout">
          <Select
            id="ni-layout"
            value={draft.layout}
            onChange={(event) => setDraft({ ...draft, layout: event.target.value as Draft["layout"] })}
          >
            <option value="AUTO">Automatic</option>
            <option value="DROPDOWN">Dropdown</option>
            <option value="MEGA">Mega menu</option>
          </Select>
        </Field>

        <Field label="Starts" htmlFor="ni-starts" hint="Blank means immediately.">
          <Input
            id="ni-starts"
            type="datetime-local"
            value={draft.starts_at}
            onChange={(event) => setDraft({ ...draft, starts_at: event.target.value })}
          />
        </Field>

        <Field label="Ends" htmlFor="ni-ends" hint="Blank means it never expires.">
          <Input
            id="ni-ends"
            type="datetime-local"
            value={draft.ends_at}
            onChange={(event) => setDraft({ ...draft, ends_at: event.target.value })}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-body-sm">
        <Checkbox
          checked={draft.is_active}
          onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })}
        />
        Active
      </label>

      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>
          <Check aria-hidden /> {creating ? "Add item" : "Save item"}
        </Button>
        <Button variant="secondary" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  function group(placement: "HEADER" | "FOOTER") {
    return items.filter((item) => item.placement === placement).sort((a, b) => a.position - b.position);
  }

  function section(placement: "HEADER" | "FOOTER", title: string, hint: string) {
    const rows = group(placement);
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-0.5 text-caption text-muted">{hint}</p>
          </div>
          {creating !== placement && (
            <Button size="sm" variant="secondary" onClick={() => startCreate(placement)}>
              <Plus aria-hidden /> Add item
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {creating === placement && form}

          {rows.length === 0 && creating !== placement && (
            <p className="text-body-sm text-muted">
              No overrides — the navbar falls back to the category tree.
            </p>
          )}

          {rows.map((item, index) =>
            editing === item.id ? (
              <div key={item.id}>{form}</div>
            ) : (
              <div key={item.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-body-sm font-medium">
                      {item.display_label}
                      {item.badge && (
                        <span className="ml-2 rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                          {item.badge}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-caption text-muted">
                      {item.type === "CATEGORY" ? `Category: ${item.category_name}` : item.url}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <Badge tone={isLive(item) ? "success" : "neutral"}>
                      {isLive(item) ? "Live" : item.is_active ? "Scheduled" : "Inactive"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(item, "up")}
                      disabled={index === 0 || moving === item.id}
                      aria-label={`Move ${item.display_label} up`}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(item, "down")}
                      disabled={index === rows.length - 1 || moving === item.id}
                      aria-label={`Move ${item.display_label} down`}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startEdit(item)}
                      aria-label={`Edit ${item.display_label}`}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(item)}
                      aria-label={`Remove ${item.display_label}`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              </div>
            ),
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {section("HEADER", "Header navigation", "The main navbar. Empty means categories drive it.")}
      {section("FOOTER", "Footer navigation", "The 'Shop' column in the footer.")}
    </div>
  );
}
