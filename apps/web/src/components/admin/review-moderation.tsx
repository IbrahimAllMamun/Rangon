"use client";

import { Check, ShieldCheck, Star, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { dateTime } from "@/lib/format";

export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ReviewRow {
  id: string;
  product: string;
  product_name: string;
  customer: string;
  customer_name: string;
  order: string | null;
  rating: number;
  title: string;
  comment: string;
  verified_purchase: boolean;
  status: ReviewStatus;
  moderation_note: string;
  moderated_at: string | null;
  created_at: string;
}

const STATUS_TONE: Record<ReviewStatus, "warning" | "success" | "neutral"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "neutral",
};

/** Rating as stars plus the number — never colour or shape alone (WCAG 1.4.1). */
function Rating({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="flex">
        {Array.from({ length: 5 }, (_, index) => (
          <Star
            key={index}
            className={
              index < value ? "size-3.5 fill-[var(--warning)] text-[var(--warning)]" : "size-3.5 text-neutral-300"
            }
          />
        ))}
      </span>
      <span className="text-caption text-muted">{value} out of 5</span>
    </span>
  );
}

/**
 * Approve or reject customer reviews.
 *
 * Nothing a customer writes reaches the storefront until someone here approves
 * it, and the aggregate rating on a product page counts approved reviews only —
 * so this screen is the whole of that gate.
 *
 * A decision is reversible: an approved review can be rejected later and the
 * other way round, which is why the note box stays available on every row
 * rather than only on pending ones. Each decision is audit-logged, so reversing
 * one adds a record rather than replacing the last.
 */
export function ReviewModeration({
  reviews,
  canModerate,
  status,
}: {
  reviews: ReviewRow[];
  canModerate: boolean;
  status: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function moderate(review: ReviewRow, decision: "approve" | "reject") {
    setBusyId(review.id);
    setError(null);
    try {
      const note = notes[review.id]?.trim();
      await apiClient(`/reviews/${review.id}/${decision}/`, {
        method: "POST",
        body: note ? { note } : {},
      });
      setNotes((current) => ({ ...current, [review.id]: "" }));
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not record that decision. Please try again.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (reviews.length === 0) {
    return (
      <Card>
        <EmptyState
          title={status === "PENDING" ? "Nothing waiting" : "No reviews here"}
          description={
            status === "PENDING"
              ? "Reviews appear here as customers write them. Until one is approved, nothing shows on the storefront."
              : "Try a different status filter."
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-body-sm text-[var(--error)]">
          {error}
        </p>
      )}

      {reviews.map((review) => (
        <Card key={review.id}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">{review.product_name}</p>
                <p className="text-body-sm text-muted">
                  {review.customer_name} · {dateTime(review.created_at)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Rating value={review.rating} />
                <Badge tone={STATUS_TONE[review.status]}>
                  {review.status === "PENDING"
                    ? "Awaiting moderation"
                    : review.status === "APPROVED"
                      ? "Approved"
                      : "Rejected"}
                </Badge>
                {review.verified_purchase && (
                  <Badge tone="info">
                    <ShieldCheck className="size-3" aria-hidden />
                    Verified purchase
                  </Badge>
                )}
              </div>
            </div>

            {review.title && <p className="font-medium">{review.title}</p>}
            {review.comment ? (
              <p className="whitespace-pre-line text-body-sm">{review.comment}</p>
            ) : (
              <p className="text-body-sm italic text-muted">A rating with no written comment.</p>
            )}

            {review.moderation_note && (
              <p className="rounded-md bg-neutral-50 p-3 text-body-sm text-muted">
                <span className="font-medium">Moderator note:</span> {review.moderation_note}
                {review.moderated_at && ` · ${dateTime(review.moderated_at)}`}
              </p>
            )}

            {canModerate && (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Note"
                  htmlFor={`note-${review.id}`}
                  hint="Optional. Kept if you leave it blank."
                  className="min-w-[16rem] flex-1"
                >
                  <Input
                    id={`note-${review.id}`}
                    value={notes[review.id] ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [review.id]: event.target.value }))
                    }
                    placeholder="Why this decision?"
                  />
                </Field>
                <div className="flex items-center gap-2">
                  {review.status !== "APPROVED" && (
                    <Button
                      onClick={() => moderate(review, "approve")}
                      loading={busyId === review.id}
                      disabled={busyId !== null}
                    >
                      <Check className="size-4" aria-hidden />
                      Approve
                    </Button>
                  )}
                  {review.status !== "REJECTED" && (
                    <Button
                      variant="secondary"
                      onClick={() => moderate(review, "reject")}
                      loading={busyId === review.id}
                      disabled={busyId !== null}
                    >
                      <X className="size-4" aria-hidden />
                      Reject
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
