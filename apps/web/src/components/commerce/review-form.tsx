"use client";

import { Check, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, Field, Input, Textarea } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";

/**
 * Write a review (D2).
 *
 * The product page has rendered reviews and their JSON-LD ratings since phase
 * 20, but nothing ever called `POST /shop/products/{slug}/reviews/`, so the
 * count could never grow and moderation had nothing to moderate.
 *
 * Eligibility is the API's call, not this form's: it accepts a review only from
 * a customer with a DELIVERED/RETURNED/REFUNDED order containing the product,
 * and only once per purchase. Rather than duplicating that rule here (and
 * getting it subtly wrong), the form submits and shows what the API says.
 */
export function ReviewForm({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <div className="rounded-lg border border-border bg-neutral-50 p-6">
        <h3 className="text-body font-semibold">Bought this? Tell other shoppers.</h3>
        <p className="mt-1 text-body-sm text-muted">
          Reviews can be written by customers who have received the item.
        </p>
        <Button asChild className="mt-4">
          <Link href={`/login?next=/product/${slug}`}>Sign in to review</Link>
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-lg border border-border bg-neutral-50 p-6"
      >
        <Check className="mt-0.5 size-5 shrink-0 text-[var(--success)]" aria-hidden />
        <div>
          <h3 className="text-body font-semibold">Thank you</h3>
          <p className="mt-1 text-body-sm text-muted">{done}</p>
        </div>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (rating < 1) {
      setError("Choose a star rating.");
      return;
    }

    setSaving(true);
    try {
      const response = await apiClient<{ message: string }>(
        `/shop/products/${slug}/reviews/`,
        { method: "POST", body: { rating, title, comment } },
      );
      setDone(response.message ?? "Your review will appear once it has been checked.");
    } catch (caught) {
      // The API's message is the useful one — "you can only review a product
      // you have received", "you have already reviewed this purchase".
      setError(
        caught instanceof ApiError ? caught.message : "Could not send your review. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  const shown = hovered || rating;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="rounded-lg border border-border bg-neutral-50 p-6"
      aria-labelledby="review-form-heading"
    >
      <h3 id="review-form-heading" className="text-body font-semibold">
        Write a review
      </h3>

      {error && (
        <p role="alert" className="mt-3 text-body-sm font-medium text-[var(--error)]">
          {error}
        </p>
      )}

      {/* Real radios rather than styled buttons: arrow-key navigation, a single
          tab stop and "3 stars, selected" all come for free, and the group
          still works with JavaScript half-loaded. */}
      <fieldset className="mt-4" onMouseLeave={() => setHovered(0)}>
        <legend className="mb-1.5 text-body-sm font-medium">
          Rating <span className="text-[var(--error)]">*</span>
        </legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <label
              key={star}
              className="cursor-pointer rounded-md p-1 focus-within:ring-4 focus-within:ring-[var(--ring)]"
              onMouseEnter={() => setHovered(star)}
            >
              <input
                type="radio"
                name="rating"
                value={star}
                checked={rating === star}
                onChange={() => setRating(star)}
                onFocus={() => setHovered(star)}
                onBlur={() => setHovered(0)}
                className="sr-only"
              />
              <span className="sr-only">
                {star} star{star === 1 ? "" : "s"}
              </span>
              <Star
                className={cn(
                  "size-7 transition-colors duration-fast",
                  star <= shown ? "fill-brand-500 text-brand-500" : "text-neutral-300",
                )}
                aria-hidden
              />
            </label>
          ))}
          <span className="ml-2 text-body-sm text-muted" aria-hidden>
            {rating ? `${rating} of 5` : "Tap a star"}
          </span>
        </div>
      </fieldset>

      <div className="mt-4 space-y-4">
        <Field label="Headline" htmlFor="review-title" hint="Optional, up to 140 characters.">
          <Input
            id="review-title"
            value={title}
            maxLength={140}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Fits well and washes nicely"
          />
        </Field>

        <Field label="Your review" htmlFor="review-comment">
          <Textarea
            id="review-comment"
            rows={4}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What did you think of the fit, fabric and finish?"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          Submit review
        </Button>
        <p className="text-caption text-muted">
          Reviews are checked by a moderator before they appear.
        </p>
      </div>
    </form>
  );
}
