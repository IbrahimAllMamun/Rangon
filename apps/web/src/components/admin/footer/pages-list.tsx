"use client";

import { Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { type FieldError, type SitePageRow, errorsFrom } from "@/components/admin/footer/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorSummary,
  Field,
  Input,
} from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";
import { dateOnly } from "@/lib/format";

/** API field name -> the id of the control it belongs to (for the error summary links). */
const FIELD_IDS: Record<string, string> = { title: "new-page-title", slug: "new-page-slug" };

/** What Django's `slugify` would make of a title, for the address preview. */
function slugPreview(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .slice(0, 64);
}

/**
 * The standard pages (About, Contact, the four policies) and any the shop has
 * added. Standard pages keep their addresses and cannot be deleted, only
 * unpublished; added pages live under /pages/.
 */
export function SitePagesList({ pages, canManage }: { pages: SitePageRow[]; canManage: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const address = slugPreview(slug || title);
  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setErrors([{ field: "new-page-title", message: "Give the page a title." }]);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      const page = await apiClient<SitePageRow>("/site-pages/", {
        method: "POST",
        body: { title, slug, body: "", is_published: false },
      });
      router.push(`/admin/footer/pages/${page.slug}`);
    } catch (caught) {
      const found = errorsFrom(caught, "new-page-title", "Could not create the page.");
      setErrors(found.map((error) => ({ ...error, field: FIELD_IDS[error.field] ?? error.field })));
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Pages</CardTitle>
          <p className="mt-0.5 text-caption text-muted">
            Link any of these from the footer on the Layout &amp; links tab.
          </p>
        </div>
        {canManage && !creating && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> New page
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {creating && (
          <form
            onSubmit={create}
            noValidate
            className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4"
          >
            <ErrorSummary errors={errors} title="Could not create the page" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" htmlFor="new-page-title" required error={errorFor("new-page-title")}>
                <Input
                  id="new-page-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Size guide"
                  maxLength={120}
                  invalid={Boolean(errorFor("new-page-title"))}
                  autoFocus
                />
              </Field>
              <Field
                label="Address"
                htmlFor="new-page-slug"
                hint={address ? `The page will be at /pages/${address}` : "Blank uses the title."}
                error={errorFor("new-page-slug")}
              >
                <Input
                  id="new-page-slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder={slugPreview(title) || "size-guide"}
                  maxLength={64}
                  invalid={Boolean(errorFor("new-page-slug"))}
                />
              </Field>
            </div>
            <p className="text-caption text-muted">
              New pages start unpublished, so you can write them before anyone sees them.
            </p>
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>
                Create and edit
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreating(false);
                  setErrors([]);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Site pages</caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Page</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Address</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Last updated</th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pages.map((page) => (
                <tr key={page.slug}>
                  <td className="px-4 py-2.5 font-medium">
                    {page.title}
                    {page.is_system && (
                      <span className="ml-2 text-caption font-normal text-muted">Standard</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-caption text-muted">{page.path}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={page.is_published ? "success" : "neutral"}>
                      {page.is_published ? "Published" : "Unpublished"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {dateOnly(page.updated_at)}
                    {page.updated_by_name && ` · ${page.updated_by_name}`}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/admin/footer/pages/${page.slug}`}>
                        <Pencil aria-hidden /> {canManage ? "Edit" : "View"}
                        <span className="sr-only"> {page.title}</span>
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
