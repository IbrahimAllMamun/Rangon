"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { SaveBar } from "@/components/admin/footer/brand-form";
import { focusMoveButton, moveButtonId } from "@/components/admin/footer/move-focus";
import { type FieldError, type SocialLinkRow, errorsFrom } from "@/components/admin/footer/types";
import { SocialIcon } from "@/components/commerce/social-icons";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Input,
} from "@/components/ui/primitives";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";

type Draft = { url: string; is_visible: boolean };

/**
 * Every platform the footer can show, as one checklist in the shop's order.
 *
 * The rows exist already (a migration creates one per platform), so this is
 * only ever "fill in, tick, reorder" -- there is nothing to add or delete, and
 * a platform cannot be listed twice. Addresses are checked by the API against
 * the platform's own domain; a WhatsApp number is turned into a chat link.
 *
 * Order changes save immediately (they are one click and easy to undo); URL
 * and visibility edits wait for Save, so a half-typed address is never live.
 */
export function SocialLinksEditor({
  links,
  canManage,
}: {
  links: SocialLinkRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(links);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<{ id: string; direction: "up" | "down" } | null>(null);

  // A refresh after saving brings new rows; keep any edits still in progress.
  useEffect(() => setOrder(links), [links]);

  // After the list re-renders in its new order, put focus back where it was.
  useEffect(() => {
    if (!refocus) return;
    focusMoveButton(refocus.id, refocus.direction);
    setRefocus(null);
  }, [order, refocus]);

  const value = (link: SocialLinkRow): Draft =>
    drafts[link.id] ?? { url: link.url, is_visible: link.is_visible };
  const changed = order.filter((link) => {
    const draft = drafts[link.id];
    return draft && (draft.url !== link.url || draft.is_visible !== link.is_visible);
  });
  const dirty = changed.length > 0;
  useUnsavedChangesWarning(dirty);

  function edit(link: SocialLinkRow, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [link.id]: { ...value(link), ...patch } }));
    setSaved(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    for (const link of changed) {
      const draft = value(link);
      if (draft.is_visible && !draft.url.trim()) {
        found.push({ field: `social-${link.platform}`, message: `Add the ${link.label} address before showing it.` });
      }
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setErrors([]);
    const failures: FieldError[] = [];
    const done: string[] = [];
    // One request per changed row: each is validated against its own
    // platform, and one bad address must not block the rest from saving.
    for (const link of changed) {
      const draft = value(link);
      try {
        const stored = await apiClient<SocialLinkRow>(`/social-links/${link.id}/`, {
          method: "PATCH",
          body: { url: draft.url, is_visible: draft.is_visible },
        });
        // The API normalises (`facebook.com/x` -> `https://facebook.com/x`);
        // show what it stored, not what was typed.
        setOrder((current) => current.map((row) => (row.id === stored.id ? stored : row)));
        done.push(link.id);
      } catch (caught) {
        const [first] = errorsFrom(caught, "url", `Could not save ${link.label}.`);
        failures.push({ field: `social-${link.platform}`, message: `${link.label}: ${first.message}` });
      }
    }
    setDrafts((current) => {
      const next = { ...current };
      for (const id of done) delete next[id];
      return next;
    });
    setErrors(failures);
    setSaved(failures.length === 0);
    setSaving(false);
    router.refresh();
  }

  async function move(link: SocialLinkRow, direction: "up" | "down") {
    // One move at a time. Not enforced by disabling the buttons: a disabled
    // button drops keyboard focus mid-press.
    if (moving) return;
    const index = order.findIndex((row) => row.id === link.id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return;
    setMoving(link.id);
    try {
      await apiClient(`/social-links/${link.id}/move/`, { method: "POST", body: { direction } });
      // Reorder locally: the API has confirmed the move, and nothing else on
      // this page shows the order. No `router.refresh()` -- with fast presses a
      // refresh from one move can land after the next, flicking the list back.
      setOrder((current) => {
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
      setRefocus({ id: link.id, direction });
    } catch (caught) {
      setErrors(errorsFrom(caught, "order", "Could not move that link."));
    } finally {
      setMoving(null);
    }
  }

  const errorFor = (platform: string) =>
    errors.find((error) => error.field === `social-${platform}`)?.message;
  const preview = order.filter((link) => {
    const draft = value(link);
    return draft.is_visible && draft.url.trim();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Social media</CardTitle>
        <p className="mt-0.5 text-caption text-muted">
          Tick the profiles to show in the footer and on the Contact page, and put them in the
          order you want. Unticked profiles are kept but not shown.
        </p>
      </CardHeader>
      <CardContent>
        {!canManage && (
          <p className="mb-4 rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
            You can see these links but not change them. Editing needs the
            <code className="mx-1">content.site_manage</code> permission.
          </p>
        )}

        <form onSubmit={save} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Some links were not saved" />

          <div className="rounded-md bg-neutral-950 p-4">
            <p className="text-caption uppercase tracking-wide text-neutral-400">
              Footer preview
            </p>
            {preview.length ? (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Profiles that will be shown">
                {preview.map((link) => (
                  <li
                    key={link.id}
                    className="flex size-11 items-center justify-center rounded-full bg-neutral-900 text-neutral-300"
                    title={link.label}
                  >
                    <SocialIcon platform={link.platform} className="size-5" />
                    <span className="sr-only">{link.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-body-sm text-neutral-400">No profiles shown yet.</p>
            )}
          </div>

          <ol className="divide-y divide-border rounded-md border border-border">
            {order.map((link, index) => {
              const draft = value(link);
              const inputId = `social-${link.platform}`;
              const error = errorFor(link.platform);
              return (
                <li
                  key={link.id}
                  className={cn(
                    "grid items-center gap-3 p-3 sm:grid-cols-[auto_9rem_1fr_auto]",
                    !draft.is_visible && "bg-neutral-50",
                  )}
                >
                  <label className="flex items-center gap-2 text-body-sm">
                    <Checkbox
                      checked={draft.is_visible}
                      onChange={(event) => edit(link, { is_visible: event.target.checked })}
                      disabled={!canManage}
                      aria-describedby={error ? `${inputId}-error` : undefined}
                    />
                    <span className="sr-only">Show {link.label} in the footer</span>
                    <span
                      aria-hidden
                      className="flex size-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-700"
                    >
                      <SocialIcon platform={link.platform} className="size-4" />
                    </span>
                  </label>

                  <label htmlFor={inputId} className="text-body-sm font-medium">
                    {link.label}
                  </label>

                  <div>
                    <Input
                      id={inputId}
                      value={draft.url}
                      onChange={(event) => edit(link, { url: event.target.value })}
                      placeholder={link.example}
                      maxLength={300}
                      disabled={!canManage}
                      invalid={Boolean(error)}
                      aria-describedby={error ? `${inputId}-error` : undefined}
                      inputMode={link.platform === "WHATSAPP" ? "tel" : "url"}
                    />
                    {error && (
                      <p
                        id={`${inputId}-error`}
                        className="mt-1 text-caption font-medium text-[var(--error)]"
                      >
                        {error}
                      </p>
                    )}
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-1 justify-self-end">
                      <Button
                        id={moveButtonId("up", link.id)}
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => move(link, "up")}
                        disabled={index === 0}
                        aria-label={`Move ${link.label} up`}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        id={moveButtonId("down", link.id)}
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => move(link, "down")}
                        disabled={index === order.length - 1}
                        aria-label={`Move ${link.label} down`}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          <p className="text-caption text-muted">
            For WhatsApp, type the number (for example 01712345678); it becomes a chat link. The
            floating chat button is switched on or off on the Contact &amp; map tab.
          </p>

          {canManage && <SaveBar saving={saving} saved={saved} dirty={dirty} />}
        </form>
      </CardContent>
    </Card>
  );
}
