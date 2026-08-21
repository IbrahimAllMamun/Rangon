"use client";

import { Check, Pencil, Plus, Trash2 } from "lucide-react";
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
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";

export interface BannerRow {
  id: string;
  placement: "ANNOUNCEMENT" | "HOME_HERO";
  message: string;
  title: string;
  subtitle: string;
  cta_label: string;
  url: string;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

interface Draft {
  message: string;
  title: string;
  subtitle: string;
  cta_label: string;
  url: string;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  starts_at: string;
  ends_at: string;
}

function blank(placement: "ANNOUNCEMENT" | "HOME_HERO"): Draft {
  return {
    message: "",
    title: "",
    subtitle: "",
    cta_label: placement === "HOME_HERO" ? "Shop now" : "",
    url: "",
    dismissible: placement === "ANNOUNCEMENT",
    priority: 0,
    is_active: true,
    starts_at: "",
    ends_at: "",
  };
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function isLive(banner: BannerRow): boolean {
  if (!banner.is_active) return false;
  const now = Date.now();
  if (banner.starts_at && new Date(banner.starts_at).getTime() > now) return false;
  if (banner.ends_at && new Date(banner.ends_at).getTime() < now) return false;
  return true;
}

/**
 * Announcement bar and homepage hero (spec §5 layer 1; product-media backs the
 * hero image separately). The highest-`priority` live row of each placement
 * wins, so several can be queued and swapped by priority without deleting the
 * others.
 */
export function BannerEditor({
  placement,
  title,
  hint,
  banners,
}: {
  placement: "ANNOUNCEMENT" | "HOME_HERO";
  title: string;
  hint: string;
  banners: BannerRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank(placement));
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const rows = banners
    .filter((banner) => banner.placement === placement)
    .sort((a, b) => b.priority - a.priority);

  function startCreate() {
    setDraft(blank(placement));
    setCreating(true);
    setEditing(null);
    setErrors([]);
  }

  function startEdit(banner: BannerRow) {
    setDraft({
      message: banner.message,
      title: banner.title,
      subtitle: banner.subtitle,
      cta_label: banner.cta_label,
      url: banner.url,
      dismissible: banner.dismissible,
      priority: banner.priority,
      is_active: banner.is_active,
      starts_at: toDatetimeLocal(banner.starts_at),
      ends_at: toDatetimeLocal(banner.ends_at),
    });
    setEditing(banner.id);
    setCreating(false);
    setErrors([]);
  }

  function cancel() {
    setEditing(null);
    setCreating(false);
    setErrors([]);
  }

  async function save() {
    const found: { field: string; message: string }[] = [];
    if (placement === "ANNOUNCEMENT" && !draft.message.trim()) {
      found.push({ field: "message", message: "An announcement needs a message." });
    }
    if (placement === "HOME_HERO" && !draft.title.trim()) {
      found.push({ field: "title", message: "A hero banner needs a title." });
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    const body = {
      placement,
      message: draft.message,
      title: draft.title,
      subtitle: draft.subtitle,
      cta_label: draft.cta_label,
      url: draft.url,
      dismissible: draft.dismissible,
      priority: draft.priority,
      is_active: draft.is_active,
      starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : null,
      ends_at: draft.ends_at ? new Date(draft.ends_at).toISOString() : null,
    };

    setSaving(true);
    setErrors([]);
    try {
      if (creating) {
        await apiClient("/storefront-banners/", { method: "POST", body });
      } else {
        await apiClient(`/storefront-banners/${editing}/`, { method: "PATCH", body });
      }
      cancel();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "message", message: caught.message }],
        );
      } else {
        setErrors([{ field: "message", message: "Could not save the banner." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(banner: BannerRow) {
    if (!window.confirm("Remove this banner?")) return;
    await apiClient(`/storefront-banners/${banner.id}/`, { method: "DELETE" });
    router.refresh();
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  const form = (
    <div className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4">
      <ErrorSummary errors={errors} title="Could not save this banner" />

      {placement === "ANNOUNCEMENT" ? (
        <Field label="Message" htmlFor="bn-message" required error={errorFor("message")}>
          <Input
            id="bn-message"
            value={draft.message}
            onChange={(event) => setDraft({ ...draft, message: event.target.value })}
            placeholder="Free delivery on orders over ৳2,000"
            invalid={Boolean(errorFor("message"))}
          />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="bn-title" required error={errorFor("title")}>
            <Input
              id="bn-title"
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              invalid={Boolean(errorFor("title"))}
            />
          </Field>
          <Field label="Subtitle" htmlFor="bn-subtitle">
            <Input
              id="bn-subtitle"
              value={draft.subtitle}
              onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })}
            />
          </Field>
          <Field label="Button label" htmlFor="bn-cta">
            <Input
              id="bn-cta"
              value={draft.cta_label}
              onChange={(event) => setDraft({ ...draft, cta_label: event.target.value })}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Link" htmlFor="bn-url" hint="Where the banner points.">
          <Input
            id="bn-url"
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            placeholder="/policies/shipping"
          />
        </Field>
        <Field label="Priority" htmlFor="bn-priority" hint="Highest priority wins when several are live.">
          <Input
            id="bn-priority"
            type="number"
            value={draft.priority}
            onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) || 0 })}
          />
        </Field>
        <Field label="Starts" htmlFor="bn-starts" hint="Blank means immediately.">
          <Input
            id="bn-starts"
            type="datetime-local"
            value={draft.starts_at}
            onChange={(event) => setDraft({ ...draft, starts_at: event.target.value })}
          />
        </Field>
        <Field label="Ends" htmlFor="bn-ends" hint="Blank means it never expires.">
          <Input
            id="bn-ends"
            type="datetime-local"
            value={draft.ends_at}
            onChange={(event) => setDraft({ ...draft, ends_at: event.target.value })}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-body-sm">
          <Checkbox
            checked={draft.is_active}
            onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })}
          />
          Active
        </label>
        {placement === "ANNOUNCEMENT" && (
          <label className="flex items-center gap-2 text-body-sm">
            <Checkbox
              checked={draft.dismissible}
              onChange={(event) => setDraft({ ...draft, dismissible: event.target.checked })}
            />
            Dismissible — shoppers can close it
          </label>
        )}
      </div>

      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>
          <Check aria-hidden /> {creating ? "Add banner" : "Save banner"}
        </Button>
        <Button variant="secondary" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-0.5 text-caption text-muted">{hint}</p>
        </div>
        {!creating && (
          <Button size="sm" variant="secondary" onClick={startCreate}>
            <Plus aria-hidden /> Add banner
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {creating && form}

        {rows.length === 0 && !creating && (
          <p className="text-body-sm text-muted">None configured.</p>
        )}

        {rows.map((banner) =>
          editing === banner.id ? (
            <div key={banner.id}>{form}</div>
          ) : (
            <div key={banner.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-body-sm font-medium">
                    {banner.message || banner.title}
                  </p>
                  <p className="mt-0.5 text-caption text-muted">
                    Priority {banner.priority}
                    {banner.url ? ` · ${banner.url}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Badge tone={isLive(banner) ? "success" : "neutral"}>
                    {isLive(banner) ? "Live" : banner.is_active ? "Scheduled" : "Inactive"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => startEdit(banner)}
                    aria-label="Edit banner"
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(banner)}
                    aria-label="Remove banner"
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
