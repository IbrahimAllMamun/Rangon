"use client";

import { MapPin, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveBar } from "@/components/admin/footer/brand-form";
import { type FieldError, type SiteSettingsRow, errorsFrom } from "@/components/admin/footer/types";
import { StoreMap } from "@/components/commerce/store-map";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import type { OpeningHours } from "@/lib/api/types";
import { apiClient } from "@/lib/api/client";
import { isGoogleMapEmbed } from "@/lib/site/format";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";

const MAX_HOURS_ROWS = 7;

type Values = Pick<
  SiteSettingsRow,
  | "address"
  | "show_address"
  | "phone"
  | "email"
  | "opening_hours"
  | "whatsapp_float"
  | "map_embed_url"
  | "map_link_url"
>;

const KEYS: (keyof Values)[] = [
  "address",
  "show_address",
  "phone",
  "email",
  "opening_hours",
  "whatsapp_float",
  "map_embed_url",
  "map_link_url",
];

function pick(settings: SiteSettingsRow): Values {
  return Object.fromEntries(KEYS.map((key) => [key, settings[key]])) as unknown as Values;
}

/**
 * What the pasted map code would show, before it is saved.
 *
 * Mirrors the API's rule loosely -- it is the API that decides what is stored
 * (`content.validators.normalize_map_embed`); this only drives the preview.
 */
function previewUrl(pasted: string): string {
  const value = pasted.trim();
  const src = value.includes("<")
    ? (/<iframe\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/is.exec(value)?.[2] ?? "")
    : value;
  const decoded = src.replaceAll("&amp;", "&");
  return isGoogleMapEmbed(decoded) ? decoded : "";
}

function embedForAddress(address: string): string {
  const query = address.split(/\s+/).filter(Boolean).join(" ");
  return query ? `https://www.google.com/maps?${new URLSearchParams({ q: query, output: "embed" })}` : "";
}

/**
 * The shop's public contact details, opening hours, map and chat button.
 *
 * These are what the *storefront* shows. Each contact field left blank uses
 * the organisation's own value from Settings, which is also what receipts
 * print -- so a shop whose storefront and registered details are the same
 * fills in nothing here.
 */
export function ContactSettingsForm({
  settings,
  canManage,
}: {
  settings: SiteSettingsRow;
  canManage: boolean;
}) {
  const router = useRouter();
  // What the server last said it stored. It normalises on save -- pasted
  // iframe code comes back as its URL, blank hours rows are dropped -- so
  // comparing against the props we started with would read as unsaved forever.
  const [baseline, setBaseline] = useState<Values>(() => pick(settings));
  const [values, setValues] = useState<Values>(baseline);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const changed = KEYS.filter(
    (key) => JSON.stringify(baseline[key]) !== JSON.stringify(values[key]),
  );
  const dirty = changed.length > 0;
  useUnsavedChangesWarning(dirty);

  const { fallbacks } = settings;
  const effectiveAddress = values.address.trim() || fallbacks.address;
  const mapPreview = previewUrl(values.map_embed_url);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function setHours(index: number, patch: Partial<OpeningHours>) {
    set(
      "opening_hours",
      values.opening_hours.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
      found.push({ field: "email", message: "Enter a valid email address." });
    }
    if (values.map_embed_url.trim() && !mapPreview) {
      found.push({
        field: "map_embed_url",
        message: "That is not Google Maps embed code. Use Share → Embed a map → Copy HTML.",
      });
    }
    if (found.length) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      const stored = await apiClient<SiteSettingsRow>("/site-settings/", {
        method: "PATCH",
        body: Object.fromEntries(changed.map((key) => [key, values[key]])),
      });
      setBaseline(pick(stored));
      setValues(pick(stored));
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setErrors(errorsFrom(caught, "address", "Could not save. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) =>
    errors.find((error) => error.field === field || error.field.startsWith(`${field}.`))?.message;
  const disabled = !canManage;

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <ErrorSummary errors={errors} title="Could not save the contact details" />

      {!canManage && (
        <p className="rounded-md bg-neutral-100 p-3 text-body-sm text-muted">
          You can see these details but not change them. Editing needs the
          <code className="mx-1">content.site_manage</code> permission.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Contact details</CardTitle>
          <p className="mt-0.5 text-caption text-muted">
            Shown under the footer logo and on the Contact page. Leave a field blank to use the
            one in{" "}
            <Link href="/admin/settings" className="font-medium text-brand-700 underline">
              Settings → Organisation
            </Link>
            .
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Shop address"
            htmlFor="contact-address"
            hint={
              fallbacks.address
                ? `Blank uses: ${fallbacks.address.replace(/\s*\n\s*/g, ", ")}`
                : "One line per line of the address. Shown in full under the footer logo."
            }
            error={errorFor("address")}
          >
            <Textarea
              id="contact-address"
              rows={3}
              value={values.address}
              onChange={(event) => set("address", event.target.value)}
              placeholder={fallbacks.address}
              maxLength={500}
              disabled={disabled}
            />
          </Field>

          <label className="flex items-center gap-2 text-body-sm">
            <Checkbox
              checked={values.show_address}
              onChange={(event) => set("show_address", event.target.checked)}
              disabled={disabled}
            />
            Show the address in the footer and on the Contact page
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              htmlFor="contact-phone"
              hint={fallbacks.phone ? `Blank uses ${fallbacks.phone}` : undefined}
              error={errorFor("phone")}
            >
              <Input
                id="contact-phone"
                type="tel"
                value={values.phone}
                onChange={(event) => set("phone", event.target.value)}
                placeholder={fallbacks.phone}
                maxLength={32}
                disabled={disabled}
              />
            </Field>
            <Field
              label="Email"
              htmlFor="contact-email"
              hint={fallbacks.email ? `Blank uses ${fallbacks.email}` : undefined}
              error={errorFor("email")}
            >
              <Input
                id="contact-email"
                type="email"
                value={values.email}
                onChange={(event) => set("email", event.target.value)}
                placeholder={fallbacks.email}
                disabled={disabled}
                invalid={Boolean(errorFor("email"))}
              />
            </Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-body-sm font-medium text-neutral-900">Opening hours</legend>
            {errorFor("opening_hours") && (
              <p className="text-caption font-medium text-[var(--error)]">
                {errorFor("opening_hours")}
              </p>
            )}
            {values.opening_hours.map((row, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Days, row ${index + 1}`}
                  value={row.days}
                  onChange={(event) => setHours(index, { days: event.target.value })}
                  placeholder="Saturday–Thursday"
                  maxLength={60}
                  disabled={disabled}
                  className="min-w-[10rem] flex-1"
                />
                <Input
                  aria-label={`Hours, row ${index + 1}`}
                  value={row.hours}
                  onChange={(event) => setHours(index, { hours: event.target.value })}
                  placeholder="10:00–20:00"
                  maxLength={60}
                  disabled={disabled}
                  className="min-w-[8rem] flex-1"
                />
                {canManage && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      set(
                        "opening_hours",
                        values.opening_hours.filter((_, i) => i !== index),
                      )
                    }
                    aria-label={`Remove opening hours row ${index + 1}`}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {canManage && values.opening_hours.length < MAX_HOURS_ROWS && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  set("opening_hours", [...values.opening_hours, { days: "", hours: "" }])
                }
              >
                <Plus aria-hidden /> Add a row
              </Button>
            )}
          </fieldset>

          <label className="flex items-start gap-2 text-body-sm">
            <Checkbox
              checked={values.whatsapp_float}
              onChange={(event) => set("whatsapp_float", event.target.checked)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span>
              Show the floating WhatsApp chat button
              <span className="block text-caption text-muted">
                Needs a WhatsApp number on the Social media tab, ticked to show.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Map</CardTitle>
          <p className="mt-0.5 text-caption text-muted">
            Shown on the Contact page. In Google Maps, find the shop, then choose Share → Embed a
            map → Copy HTML, and paste it below.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Google Maps embed code"
            htmlFor="contact-map"
            hint="The whole <iframe …> code, or just its https://www.google.com/maps/embed?… address. Only the address is kept."
            error={errorFor("map_embed_url")}
          >
            <Textarea
              id="contact-map"
              rows={3}
              value={values.map_embed_url}
              onChange={(event) => set("map_embed_url", event.target.value)}
              disabled={disabled}
              className="font-mono text-body-sm"
              spellCheck={false}
            />
          </Field>

          {canManage && effectiveAddress && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => set("map_embed_url", embedForAddress(effectiveAddress))}
              >
                <MapPin aria-hidden /> Use a map of the address instead
              </Button>
              {values.map_embed_url && (
                <Button type="button" size="sm" variant="ghost" onClick={() => set("map_embed_url", "")}>
                  Remove the map
                </Button>
              )}
            </div>
          )}

          <Field
            label="“Open in Google Maps” link"
            htmlFor="contact-map-link"
            hint="Optional. Share → Copy link in Google Maps. Blank searches Google Maps for the address."
            error={errorFor("map_link_url")}
          >
            <Input
              id="contact-map-link"
              value={values.map_link_url}
              onChange={(event) => set("map_link_url", event.target.value)}
              placeholder="https://maps.app.goo.gl/…"
              maxLength={500}
              disabled={disabled}
            />
          </Field>

          <div>
            <p className="text-body-sm font-medium">Preview</p>
            <div className="mt-2">
              {mapPreview ? (
                <StoreMap embedUrl={mapPreview} linkUrl="" title="Preview of the shop map" />
              ) : (
                <p className="rounded-md border border-dashed border-border p-6 text-center text-body-sm text-muted">
                  {values.map_embed_url.trim()
                    ? "This is not Google Maps embed code, so there is nothing to preview."
                    : "No map — the Contact page shows only the “Open in Google Maps” link."}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {canManage && <SaveBar saving={saving} saved={saved} dirty={dirty} />}
    </form>
  );
}
