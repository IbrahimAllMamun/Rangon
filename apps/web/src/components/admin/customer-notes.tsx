"use client";

import { Pin, Plus, StickyNote, Trash2 } from "lucide-react";
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
  EmptyState,
  Field,
  Textarea,
} from "@/components/ui/primitives";
import { dateTime } from "@/lib/format";
import { ApiError, apiClient } from "@/lib/api/client";

export interface CustomerNoteRow {
  id: string;
  body: string;
  is_pinned: boolean;
  created_by_email: string;
  created_at: string;
}

/**
 * Staff notes on a customer — "prefers a call before delivery", "returned twice
 * for sizing". Ordered pinned-first by the API.
 *
 * Notes are deletable because they are staff commentary, not a financial
 * record: nothing about an order or a payment depends on one. That is the line
 * CLAUDE.md §3.3 draws, and it is why this panel has a delete button while the
 * order timeline does not.
 */
export function CustomerNotes({
  customerId,
  notes,
  canManage,
}: {
  customerId: string;
  notes: CustomerNoteRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) {
      setError("Write something before adding the note.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/customers/${customerId}/notes/`, {
        method: "POST",
        body: { body: body.trim(), is_pinned: pinned },
      });
      setBody("");
      setPinned(false);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not add this note. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: CustomerNoteRow) {
    if (!window.confirm("Delete this note?")) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient(`/customers/${customerId}/notes/${note.id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <form onSubmit={add} noValidate className="space-y-3">
            <Field
              label="Add a note"
              htmlFor="note-body"
              error={error ?? undefined}
              hint="Visible to staff only."
            >
              <Textarea
                id="note-body"
                rows={2}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  setError(null);
                }}
                invalid={Boolean(error)}
                placeholder="Prefers a call before delivery…"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy}>
                <Plus className="size-4" aria-hidden />
                Add note
              </Button>
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
                Pin to the top
              </label>
            </div>
          </form>
        )}

        {notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            description="Anything the counter should know before serving this customer goes here."
          />
        ) : (
          <ul className="space-y-3">
            {notes.map((note) => (
              <li
                key={note.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="flex gap-3">
                  <StickyNote className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <div className="text-body-sm">
                    <p className="whitespace-pre-line">{note.body}</p>
                    <p className="mt-1 text-caption text-muted">
                      {note.created_by_email || "System"} · {dateTime(note.created_at)}
                    </p>
                    {note.is_pinned && (
                      <Badge tone="warning" className="mt-1.5">
                        <Pin className="size-3" aria-hidden />
                        Pinned
                      </Badge>
                    )}
                  </div>
                </div>
                {canManage && (
                  <Button variant="ghost" size="sm" onClick={() => remove(note)} disabled={busy}>
                    <Trash2 className="size-4" aria-hidden />
                    <span className="sr-only">Delete this note</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
