"use client";

import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { focusMoveButton, moveButtonId } from "@/components/admin/footer/move-focus";
import {
  type FieldError,
  type FooterItemRow,
  type SitePageRow,
  errorsFrom,
} from "@/components/admin/footer/types";
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
import { apiClient } from "@/lib/api/client";
import { refreshAfterWrite } from "@/lib/navigation/refresh-after-write";

/** The footer lays out the brand block plus this many columns (`MAX_FOOTER_COLUMNS`). */
const MAX_COLUMNS = 4;

type LinkType = "PAGE" | "CATEGORY" | "LINK" | "CATEGORY_LIST";

interface LinkDraft {
  type: LinkType;
  page: string;
  category: string;
  label: string;
  url: string;
  is_active: boolean;
}

const BLANK_LINK: LinkDraft = {
  type: "PAGE",
  page: "",
  category: "",
  label: "",
  url: "",
  is_active: true,
};

type Editing =
  | { kind: "column"; id: string | null }
  | { kind: "link"; column: string; id: string | null }
  | null;

function byPosition(a: FooterItemRow, b: FooterItemRow) {
  return a.position - b.position || a.display_label.localeCompare(b.display_label);
}

/**
 * The footer's link columns (ADR-0012).
 *
 * Each column is a `GROUP` navigation item and its links are that item's
 * children, so this writes through the same `/navigation-items/` API -- and
 * the same `content.navigation_manage` permission -- as the navbar editor.
 * Links are resolved when the footer is served: a link to an unpublished page
 * or a hidden category drops out by itself, so nothing here has to be kept in
 * step by hand.
 *
 * Reordering is Move up / Move down rather than dragging, so it works from a
 * keyboard and a single pointer (WCAG 2.5.7).
 */
export function FooterColumnsEditor({
  items,
  pages,
  categories,
  canManage,
}: {
  items: FooterItemRow[];
  pages: SitePageRow[];
  categories: { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [columnDraft, setColumnDraft] = useState({ label: "", is_active: true });
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(BLANK_LINK);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const pendingFocus = useRef<{ id: string; direction: "up" | "down" } | null>(null);

  const columns = items.filter((item) => item.type === "GROUP" && !item.parent).sort(byPosition);
  const linksOf = (columnId: string) =>
    items.filter((item) => item.parent === columnId).sort(byPosition);
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  function close() {
    setEditing(null);
    setErrors([]);
  }

  function editColumn(column: FooterItemRow | null) {
    setColumnDraft(
      column ? { label: column.label, is_active: column.is_active } : { label: "", is_active: true },
    );
    setEditing({ kind: "column", id: column?.id ?? null });
    setErrors([]);
  }

  function editLink(columnId: string, link: FooterItemRow | null) {
    setLinkDraft(
      link
        ? {
            type: (link.type === "PROMO" ? "LINK" : link.type) as LinkType,
            page: link.page ?? "",
            category: link.category ?? "",
            label: link.label,
            url: link.url,
            is_active: link.is_active,
          }
        : BLANK_LINK,
    );
    setEditing({ kind: "link", column: columnId, id: link?.id ?? null });
    setErrors([]);
  }

  async function saveColumn() {
    if (!columnDraft.label.trim()) {
      setErrors([{ field: "label", message: "Give the column a heading." }]);
      return;
    }
    if (editing?.kind !== "column") return;
    setSaving(true);
    setErrors([]);
    try {
      if (editing.id) {
        await apiClient(`/navigation-items/${editing.id}/`, { method: "PATCH", body: columnDraft });
      } else {
        await apiClient("/navigation-items/", {
          method: "POST",
          body: {
            ...columnDraft,
            placement: "FOOTER",
            type: "GROUP",
            position: columns.length ? Math.max(...columns.map((c) => c.position)) + 1 : 0,
          },
        });
      }
      close();
      await refreshAfterWrite(router);
    } catch (caught) {
      setErrors(errorsFrom(caught, "label", "Could not save the column."));
    } finally {
      setSaving(false);
    }
  }

  async function saveLink() {
    if (editing?.kind !== "link") return;
    const draft = linkDraft;
    const found: FieldError[] = [];
    if (draft.type === "PAGE" && !draft.page) found.push({ field: "page", message: "Choose a page." });
    if (draft.type === "CATEGORY" && !draft.category) {
      found.push({ field: "category", message: "Choose a category." });
    }
    if (draft.type === "LINK") {
      if (!draft.label.trim()) found.push({ field: "label", message: "A link needs a label." });
      if (!draft.url.trim()) found.push({ field: "url", message: "A link needs an address." });
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    const body = {
      type: draft.type,
      page: draft.type === "PAGE" ? draft.page : null,
      category: draft.type === "CATEGORY" ? draft.category : null,
      label: draft.type === "CATEGORY_LIST" ? "" : draft.label,
      url: draft.type === "LINK" ? draft.url : "",
      is_active: draft.is_active,
    };
    const siblings = linksOf(editing.column);

    setSaving(true);
    setErrors([]);
    try {
      if (editing.id) {
        await apiClient(`/navigation-items/${editing.id}/`, { method: "PATCH", body });
      } else {
        await apiClient("/navigation-items/", {
          method: "POST",
          body: {
            ...body,
            placement: "FOOTER",
            parent: editing.column,
            position: siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1 : 0,
          },
        });
      }
      close();
      await refreshAfterWrite(router);
    } catch (caught) {
      setErrors(errorsFrom(caught, "label", "Could not save the link."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: FooterItemRow) {
    const message =
      item.type === "GROUP"
        ? `Delete the column “${item.display_label}” and the ${linksOf(item.id).length} link(s) in it?`
        : `Remove “${item.display_label}” from the footer?`;
    if (!window.confirm(message)) return;
    setBusy(item.id);
    try {
      await apiClient(`/navigation-items/${item.id}/`, { method: "DELETE" });
      await refreshAfterWrite(router);
    } finally {
      setBusy(null);
    }
  }

  async function move(item: FooterItemRow, direction: "up" | "down") {
    // One move at a time, guarded here rather than by disabling the buttons:
    // a disabled button drops keyboard focus mid-press.
    if (busy) return;
    setBusy(item.id);
    try {
      await apiClient(`/navigation-items/${item.id}/move/`, { method: "POST", body: { direction } });
      pendingFocus.current = { id: item.id, direction };
      await refreshAfterWrite(router);
    } finally {
      setBusy(null);
    }
  }

  // The refreshed rows arrive in their new order; only then put focus back on
  // the moved row. A ref, not state: setting it must not itself re-render.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    focusMoveButton(pending.id, pending.direction);
  }, [items]);

  function describe(link: FooterItemRow): { text: string; warning?: string } {
    switch (link.type) {
      case "PAGE": {
        const page = link.page ? pageBySlug.get(link.page) : undefined;
        return {
          text: `Page: ${link.page_title || link.page}${page ? ` (${page.path})` : ""}`,
          warning: page && !page.is_published ? "Page unpublished — link hidden" : undefined,
        };
      }
      case "CATEGORY":
        return { text: `Category: ${link.category_name}` };
      case "CATEGORY_LIST":
        return { text: "Every top-level category, kept up to date automatically" };
      default:
        return { text: link.url };
    }
  }

  // A render helper, not a component: a component declared inside this one
  // would be a new type on every render, remounting the buttons and losing focus.
  function moveButtons(item: FooterItemRow, index: number, count: number) {
    if (!canManage) return null;
    return (
      <>
        <Button
          id={moveButtonId("up", item.id)}
          size="sm"
          variant="ghost"
          onClick={() => move(item, "up")}
          disabled={index === 0}
          aria-label={`Move ${item.display_label} up`}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          id={moveButtonId("down", item.id)}
          size="sm"
          variant="ghost"
          onClick={() => move(item, "down")}
          disabled={index === count - 1}
          aria-label={`Move ${item.display_label} down`}
        >
          <ArrowDown aria-hidden />
        </Button>
      </>
    );
  }

  const columnForm = (
    <div className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4">
      <ErrorSummary errors={errors} title="Could not save this column" />
      <Field label="Column heading" htmlFor="fc-label" required error={errorFor("label")}>
        <Input
          id="fc-label"
          value={columnDraft.label}
          onChange={(event) => setColumnDraft({ ...columnDraft, label: event.target.value })}
          maxLength={120}
          invalid={Boolean(errorFor("label"))}
          autoFocus
        />
      </Field>
      <label className="flex items-center gap-2 text-body-sm">
        <Checkbox
          checked={columnDraft.is_active}
          onChange={(event) => setColumnDraft({ ...columnDraft, is_active: event.target.checked })}
        />
        Show this column
      </label>
      <div className="flex gap-2">
        <Button onClick={saveColumn} loading={saving}>
          <Check aria-hidden /> {editing?.kind === "column" && editing.id ? "Save column" : "Add column"}
        </Button>
        <Button variant="secondary" onClick={close} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  const linkForm = (
    <div className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4">
      <ErrorSummary errors={errors} title="Could not save this link" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Links to" htmlFor="fl-type">
          <Select
            id="fl-type"
            value={linkDraft.type}
            onChange={(event) =>
              setLinkDraft({ ...linkDraft, type: event.target.value as LinkType })
            }
          >
            <option value="PAGE">A site page (About, a policy…)</option>
            <option value="CATEGORY">A category</option>
            <option value="LINK">Any address</option>
            <option value="CATEGORY_LIST">Top categories (automatic)</option>
          </Select>
        </Field>

        {linkDraft.type === "PAGE" && (
          <Field label="Page" htmlFor="fl-page" required error={errorFor("page")}>
            <Select
              id="fl-page"
              value={linkDraft.page}
              onChange={(event) => setLinkDraft({ ...linkDraft, page: event.target.value })}
              invalid={Boolean(errorFor("page"))}
            >
              <option value="">Choose a page…</option>
              {pages.map((page) => (
                <option key={page.slug} value={page.slug}>
                  {page.title}
                  {page.is_published ? "" : " (unpublished)"}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {linkDraft.type === "CATEGORY" && (
          <Field label="Category" htmlFor="fl-category" required error={errorFor("category")}>
            <Select
              id="fl-category"
              value={linkDraft.category}
              onChange={(event) => setLinkDraft({ ...linkDraft, category: event.target.value })}
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
        )}

        {linkDraft.type === "LINK" && (
          <Field
            label="Address"
            htmlFor="fl-url"
            required
            hint="A page on this site such as /shop?sort=newest, or https://…"
            error={errorFor("url")}
          >
            <Input
              id="fl-url"
              value={linkDraft.url}
              onChange={(event) => setLinkDraft({ ...linkDraft, url: event.target.value })}
              placeholder="/shop?sort=newest"
              maxLength={300}
              invalid={Boolean(errorFor("url"))}
            />
          </Field>
        )}

        {linkDraft.type !== "CATEGORY_LIST" && (
          <Field
            label="Label"
            htmlFor="fl-label"
            required={linkDraft.type === "LINK"}
            hint={
              linkDraft.type === "LINK" ? undefined : "Blank uses the page's or category's own name."
            }
            error={errorFor("label")}
          >
            <Input
              id="fl-label"
              value={linkDraft.label}
              onChange={(event) => setLinkDraft({ ...linkDraft, label: event.target.value })}
              maxLength={120}
              invalid={Boolean(errorFor("label"))}
            />
          </Field>
        )}
      </div>

      {linkDraft.type === "CATEGORY_LIST" && (
        <p className="text-body-sm text-muted">
          Lists up to eight top-level categories that are shown in the navbar, in the catalogue&apos;s
          order. New categories appear here by themselves.
        </p>
      )}

      <label className="flex items-center gap-2 text-body-sm">
        <Checkbox
          checked={linkDraft.is_active}
          onChange={(event) => setLinkDraft({ ...linkDraft, is_active: event.target.checked })}
        />
        Show this link
      </label>

      <div className="flex gap-2">
        <Button onClick={saveLink} loading={saving}>
          <Check aria-hidden /> {editing?.kind === "link" && editing.id ? "Save link" : "Add link"}
        </Button>
        <Button variant="secondary" onClick={close} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Footer columns</CardTitle>
          <p className="mt-0.5 text-caption text-muted">
            Up to {MAX_COLUMNS} columns of links beside the logo. A column with nothing live in it
            is left out.
          </p>
        </div>
        {canManage && editing?.kind !== "column" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => editColumn(null)}
            disabled={columns.length >= MAX_COLUMNS}
            title={columns.length >= MAX_COLUMNS ? "The footer has room for four columns" : undefined}
          >
            <Plus aria-hidden /> Add column
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {!canManage && (
          <p className="rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
            You can see the footer columns but not change them. Editing needs the
            <code className="mx-1">content.navigation_manage</code> permission.
          </p>
        )}

        {editing?.kind === "column" && !editing.id && columnForm}

        {columns.length === 0 && editing?.kind !== "column" && (
          <p className="text-body-sm text-muted">
            No columns yet — the footer shows only the logo and contact details.
          </p>
        )}

        {columns.map((column, columnIndex) => {
          const links = linksOf(column.id);
          return (
            <section
              key={column.id}
              aria-labelledby={`fc-${column.id}`}
              className="rounded-md border border-border"
            >
              {editing?.kind === "column" && editing.id === column.id ? (
                <div className="p-3">{columnForm}</div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-neutral-50 px-3 py-2">
                  <h3 id={`fc-${column.id}`} className="text-body-sm font-semibold uppercase tracking-wide">
                    {column.display_label}
                  </h3>
                  <div className="flex items-center gap-1">
                    {!column.is_active && <Badge tone="neutral">Hidden</Badge>}
                    {moveButtons(column, columnIndex, columns.length)}
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => editColumn(column)}
                          aria-label={`Rename or hide the ${column.display_label} column`}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(column)}
                          disabled={busy === column.id}
                          aria-label={`Delete the ${column.display_label} column`}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              <ul className="divide-y divide-border">
                {links.map((link, index) => {
                  if (editing?.kind === "link" && editing.id === link.id) {
                    return (
                      <li key={link.id} className="p-3">
                        {linkForm}
                      </li>
                    );
                  }
                  const { text, warning } = describe(link);
                  return (
                    <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-body-sm font-medium">{link.display_label}</p>
                        <p className="truncate text-caption text-muted">{text}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        {warning && <Badge tone="warning">{warning}</Badge>}
                        {!link.is_active && <Badge tone="neutral">Hidden</Badge>}
                        {moveButtons(link, index, links.length)}
                        {canManage && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => editLink(column.id, link)}
                              aria-label={`Edit ${link.display_label}`}
                            >
                              <Pencil aria-hidden />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => remove(link)}
                              disabled={busy === link.id}
                              aria-label={`Remove ${link.display_label}`}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
                {links.length === 0 && (
                  <li className="px-3 py-2 text-body-sm text-muted">No links yet.</li>
                )}
              </ul>

              {canManage && (
                <div className="border-t border-border p-3">
                  {editing?.kind === "link" && editing.column === column.id && !editing.id ? (
                    linkForm
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => editLink(column.id, null)}>
                      <Plus aria-hidden /> Add link to {column.display_label}
                    </Button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
