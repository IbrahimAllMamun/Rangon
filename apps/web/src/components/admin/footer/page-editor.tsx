"use client";

import { ExternalLink, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveBar } from "@/components/admin/footer/brand-form";
import { type FieldError, type SitePageRow, errorsFrom } from "@/components/admin/footer/types";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";
import { dateTime } from "@/lib/format";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";

type Meta = Pick<SitePageRow, "title" | "meta_description" | "is_published">;

function metaOf(page: SitePageRow): Meta {
  return {
    title: page.title,
    meta_description: page.meta_description,
    is_published: page.is_published,
  };
}

/** Search engines show roughly this much of a description before cutting it. */
const DESCRIPTION_SWEET_SPOT = 160;

/** API field name -> the id of the control it belongs to (for the error summary links). */
const FIELD_IDS: Record<string, string> = {
  title: "page-title",
  meta_description: "page-description",
  body: "page-body",
};

/**
 * One site page: its title, search description, whether it is published, and
 * its body in the rich-text editor.
 *
 * Whatever is typed, the API sanitises the body before storing it, and the
 * storefront renders only what was stored.
 */
export function SitePageEditor({ page, canManage }: { page: SitePageRow; canManage: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState(page);
  const [meta, setMeta] = useState<Meta>(() => metaOf(page));
  const [body, setBody] = useState(page.body);
  // TipTap re-serialises HTML its own way, so the body is "changed" when it
  // has been edited, not when its string differs from what the API sent.
  const [bodyTouched, setBodyTouched] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const baseline = metaOf(current);
  const changedMeta = (Object.keys(baseline) as (keyof Meta)[]).filter(
    (key) => baseline[key] !== meta[key],
  );
  const dirty = changedMeta.length > 0 || bodyTouched;
  useUnsavedChangesWarning(dirty);

  function setField<K extends keyof Meta>(key: K, value: Meta[K]) {
    setMeta((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!meta.title.trim()) {
      setErrors([{ field: "page-title", message: "A page needs a title." }]);
      return;
    }
    const payload: Record<string, unknown> = Object.fromEntries(
      changedMeta.map((key) => [key, meta[key]]),
    );
    if (bodyTouched) payload.body = body;

    setSaving(true);
    setErrors([]);
    try {
      const stored = await apiClient<SitePageRow>(`/site-pages/${current.slug}/`, {
        method: "PATCH",
        body: payload,
      });
      setCurrent(stored);
      setMeta(metaOf(stored));
      setBodyTouched(false);
      setSaved(true);
      router.refresh();
    } catch (caught) {
      const found = errorsFrom(caught, "page-title", "Could not save the page.");
      setErrors(found.map((error) => ({ ...error, field: FIELD_IDS[error.field] ?? error.field })));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const question = `Delete “${current.title}”? Footer links to it are removed too. This cannot be undone.`;
    if (!window.confirm(question)) return;
    try {
      await apiClient(`/site-pages/${current.slug}/`, { method: "DELETE" });
      router.push("/admin/footer?tab=pages");
      router.refresh();
    } catch (caught) {
      setErrors(errorsFrom(caught, "page-title", "Could not delete the page."));
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const descriptionLength = meta.meta_description.length;

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      <ErrorSummary errors={errors} title="Could not save this page" />

      {!canManage && (
        <p className="rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
          You can read this page but not change it. Editing needs the
          <code className="mx-1">content.site_manage</code> permission.
        </p>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field label="Title" htmlFor="page-title" required error={errorFor("page-title")}>
            <Input
              id="page-title"
              value={meta.title}
              onChange={(event) => setField("title", event.target.value)}
              maxLength={120}
              disabled={!canManage}
              invalid={Boolean(errorFor("page-title"))}
            />
          </Field>

          <Field
            label="Search description"
            htmlFor="page-description"
            hint={`What search engines show under the title. ${descriptionLength}/300 — about ${DESCRIPTION_SWEET_SPOT} characters is shown in full.`}
            error={errorFor("page-description")}
          >
            <Textarea
              id="page-description"
              rows={2}
              value={meta.meta_description}
              onChange={(event) => setField("meta_description", event.target.value)}
              maxLength={300}
              disabled={!canManage}
              invalid={Boolean(errorFor("page-description"))}
            />
          </Field>

          <label className="flex items-start gap-2 text-body-sm">
            <Checkbox
              checked={meta.is_published}
              onChange={(event) => setField("is_published", event.target.checked)}
              disabled={!canManage}
              className="mt-0.5"
            />
            <span>
              Published
              <span className="block text-caption text-muted">
                Unpublished pages are not found at {current.path}, and footer links to them are
                hidden until they are published again.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <p id="page-body-label" className="text-body-sm font-medium text-neutral-900">
          Page text
        </p>
        <RichTextEditor
          id="page-body"
          labelledBy="page-body-label"
          initialHtml={page.body}
          disabled={!canManage}
          onChange={(html) => {
            setBody(html);
            setBodyTouched(true);
            setSaved(false);
          }}
        />
        {errorFor("page-body") ? (
          <p className="text-caption font-medium text-[var(--error)]">{errorFor("page-body")}</p>
        ) : (
          <p className="text-caption text-muted">
            The title above is the page heading, so start with a paragraph or a heading. Pasted
            styling (fonts, colours) is removed when the page is saved.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {canManage ? <SaveBar saving={saving} saved={saved} dirty={dirty} label="Save page" /> : <span />}
        <div className="flex items-center gap-2">
          {current.is_published && (
            <Button asChild variant="secondary" size="sm">
              <a href={current.path} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden /> View on site
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </Button>
          )}
          {canManage && !current.is_system && (
            <Button type="button" variant="ghost" size="sm" onClick={remove}>
              <Trash2 aria-hidden /> Delete page
            </Button>
          )}
        </div>
      </div>

      {current.updated_by_name && (
        <p className="text-caption text-muted">
          Last saved {dateTime(current.updated_at)} by {current.updated_by_name}.
        </p>
      )}
    </form>
  );
}
