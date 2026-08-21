"use client";

import { ImagePlus, Star, Trash2 } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient, apiUpload } from "@/lib/api/client";
import { cn } from "@/lib/cn";

export interface ProductImageRow {
  id: string;
  url: string;
  alt: string;
  alt_text: string;
  position: number;
  is_primary: boolean;
  attribute_value: string | null;
  color: { code: string; value: string; label: string; swatch: string } | null;
}

export interface ColourOption {
  id: string;
  label: string;
  swatch: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];

/**
 * Per-colour product photography (product-media.md phase B3).
 *
 * Images bind to a colour `AttributeValue`, not to a variant: a shirt in three
 * colours and four sizes has twelve variants but three photo shoots. Uploading
 * against the colour means every size shows it, and adding XXL later inherits
 * the pictures instead of shipping a variant with none.
 *
 * "Every colour" (no colour) is the right answer for a flat-lay, a size chart
 * or packaging. The API refuses a colour the product has no variant in, which
 * is why this only appears once the product has been saved with its variants.
 */
export function ProductImages({
  productId,
  images,
  colours,
}: {
  productId: string;
  images: ProductImageRow[];
  colours: ColourOption[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [colour, setColour] = useState("");
  const [altText, setAltText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    for (const file of Array.from(files)) {
      if (!ACCEPTED.includes(file.type)) {
        setError(`${file.name} is not a JPEG, PNG, WebP or AVIF.`);
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is larger than 5 MB.`);
        return;
      }
    }

    setBusy(true);
    try {
      let position = images.length;
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("product", productId);
        form.set("image", file);
        if (colour) form.set("attribute_value", colour);
        if (altText) form.set("alt_text", altText);
        form.set("position", String(position));
        position += 1;
        await apiUpload("/product-images/", form);
      }
      setAltText("");
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    setBusy(true);
    try {
      await apiClient(`/product-images/${id}/`, { method: "PATCH", body });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the image.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this image? This cannot be undone.")) return;
    setError(null);
    setBusy(true);
    try {
      await apiClient(`/product-images/${id}/`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not delete the image.");
    } finally {
      setBusy(false);
    }
  }

  const grouped = groupByColour(images, colours);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Photography</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p role="alert" className="rounded-md bg-[var(--error-bg)] p-3 text-body-sm text-[var(--error)]">
            {error}
          </p>
        )}

        <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
          <Field
            label="Colour"
            htmlFor="image-colour"
            hint="Blank shows the image for every colour."
          >
            <Select
              id="image-colour"
              value={colour}
              onChange={(event) => setColour(event.target.value)}
            >
              <option value="">Every colour (shared)</option>
              {colours.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Alt text" htmlFor="image-alt" hint="Left blank, one is derived from the name and colour.">
            <Input
              id="image-alt"
              value={altText}
              onChange={(event) => setAltText(event.target.value)}
              placeholder="Model wearing the black oxford shirt, front view"
            />
          </Field>

          {/* A styled <label> wrapping a visually-hidden (but still focusable)
              file input. A <button> that forwards a click to a hidden input
              would leave the input as a second, unlabelled tab stop; this way
              there is one control, it has a name, and Tab reaches it with the
              focus ring drawn on the label. */}
          <label
            htmlFor="image-file"
            className={cn(
              "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md px-4",
              "bg-brand-500 text-body-sm font-semibold text-white transition-colors duration-fast",
              "hover:bg-brand-600 active:bg-brand-700",
              "focus-within:ring-4 focus-within:ring-[var(--ring)]",
              busy && "pointer-events-none opacity-50",
            )}
          >
            <input
              ref={fileInput}
              id="image-file"
              type="file"
              accept={ACCEPTED.join(",")}
              multiple
              disabled={busy}
              className="sr-only"
              onChange={(event) => void upload(event.target.files)}
            />
            <ImagePlus className="size-4" aria-hidden />
            {busy ? "Uploading…" : "Upload images"}
          </label>
        </div>

        {colours.length === 0 && (
          <p className="text-body-sm text-muted">
            This product has no colour variants, so every image is shared.
          </p>
        )}

        {images.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-8 text-center text-body-sm text-muted">
            No images yet. Storefront cards and the product page show a placeholder until one is
            uploaded.
          </p>
        ) : (
          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.key} aria-labelledby={`images-${group.key}`}>
                <h3
                  id={`images-${group.key}`}
                  className="mb-3 flex items-center gap-2 text-body-sm font-semibold"
                >
                  {group.swatch && (
                    <span
                      className="size-4 rounded-full border border-border"
                      style={{ backgroundColor: group.swatch }}
                      aria-hidden
                    />
                  )}
                  {group.label}
                  <span className="font-normal text-muted">({group.images.length})</span>
                </h3>

                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  {group.images.map((image) => (
                    <li
                      key={image.id}
                      className={cn(
                        "overflow-hidden rounded-lg border bg-surface",
                        image.is_primary ? "border-brand-500" : "border-border",
                      )}
                    >
                      <div className="relative aspect-product bg-neutral-100">
                        {image.url && (
                          <Image
                            src={image.url}
                            alt={image.alt || image.alt_text}
                            fill
                            sizes="(max-width: 640px) 50vw, 20vw"
                            className="object-cover"
                          />
                        )}
                      </div>
                      <div className="space-y-2 p-2">
                        {image.is_primary && <Badge tone="brand">Primary</Badge>}
                        <div className="flex items-center justify-between gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || image.is_primary}
                            onClick={() => void patch(image.id, { is_primary: true })}
                          >
                            <Star className="size-4" aria-hidden />
                            {image.is_primary ? "Primary" : "Make primary"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            onClick={() => void remove(image.id)}
                            aria-label="Delete image"
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ImageGroup {
  key: string;
  label: string;
  swatch: string;
  images: ProductImageRow[];
}

function groupByColour(images: ProductImageRow[], colours: ColourOption[]): ImageGroup[] {
  const shared: ImageGroup = { key: "shared", label: "Every colour", swatch: "", images: [] };
  const byColour = new Map<string, ImageGroup>();

  for (const image of images) {
    if (!image.attribute_value) {
      shared.images.push(image);
      continue;
    }
    const known = colours.find((colour) => colour.id === image.attribute_value);
    const group = byColour.get(image.attribute_value) ?? {
      key: image.attribute_value,
      label: image.color?.label ?? known?.label ?? "Colour",
      swatch: image.color?.swatch ?? known?.swatch ?? "",
      images: [],
    };
    group.images.push(image);
    byColour.set(image.attribute_value, group);
  }

  const groups = [...byColour.values()];
  return shared.images.length ? [shared, ...groups] : groups;
}
