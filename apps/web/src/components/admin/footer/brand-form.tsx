"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { type FieldError, type SiteSettingsRow, errorsFrom } from "@/components/admin/footer/types";
import {
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
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";

type Values = Pick<SiteSettingsRow, "tagline" | "copyright_text" | "bottom_note">;

function pick(settings: SiteSettingsRow): Values {
  return {
    tagline: settings.tagline,
    copyright_text: settings.copyright_text,
    bottom_note: settings.bottom_note,
  };
}

/**
 * The words around the footer's links: the tagline under the logo, and the
 * two lines of the bottom bar. Contact details live on the Contact & map tab.
 */
export function FooterBrandForm({
  settings,
  canManage,
}: {
  settings: SiteSettingsRow;
  canManage: boolean;
}) {
  const router = useRouter();
  // The server trims what it stores; compare against its answer, not the props.
  const [baseline, setBaseline] = useState<Values>(() => pick(settings));
  const [values, setValues] = useState<Values>(baseline);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const changed = (Object.keys(baseline) as (keyof Values)[]).filter(
    (key) => baseline[key] !== values[key],
  );
  const dirty = changed.length > 0;
  useUnsavedChangesWarning(dirty);

  function set(key: keyof Values, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors([]);
    setSaving(true);
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
      setErrors(errorsFrom(caught, "tagline", "Could not save. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const year = new Date().getFullYear();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Footer text</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ErrorSummary errors={errors} title="Could not save the footer text" />

          <Field
            label="Tagline"
            htmlFor="footer-tagline"
            hint="One line under the logo."
            error={errorFor("tagline")}
          >
            <Input
              id="footer-tagline"
              value={values.tagline}
              onChange={(event) => set("tagline", event.target.value)}
              maxLength={200}
              disabled={!canManage}
              invalid={Boolean(errorFor("tagline"))}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Copyright line"
              htmlFor="footer-copyright"
              hint={`Blank uses “© ${year} ${settings.fallbacks.name || "Rangon Fashion"}. All rights reserved.” Write {year} for the current year.`}
              error={errorFor("copyright_text")}
            >
              <Input
                id="footer-copyright"
                value={values.copyright_text}
                onChange={(event) => set("copyright_text", event.target.value)}
                placeholder="© {year} Rangon Fashion. All rights reserved."
                maxLength={200}
                disabled={!canManage}
                invalid={Boolean(errorFor("copyright_text"))}
              />
            </Field>

            <Field
              label="Bottom note"
              htmlFor="footer-note"
              hint="Shown opposite the copyright line. Blank hides it."
              error={errorFor("bottom_note")}
            >
              <Input
                id="footer-note"
                value={values.bottom_note}
                onChange={(event) => set("bottom_note", event.target.value)}
                maxLength={200}
                disabled={!canManage}
                invalid={Boolean(errorFor("bottom_note"))}
              />
            </Field>
          </div>

          {canManage && (
            <SaveBar saving={saving} saved={saved} dirty={dirty} />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

/** Save button plus the "Saved" / "Unsaved changes" status beside it. */
export function SaveBar({
  saving,
  saved,
  dirty,
  label = "Save changes",
}: {
  saving: boolean;
  saved: boolean;
  dirty: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" loading={saving} disabled={!dirty}>
        {label}
      </Button>
      {saved && !dirty && (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success-text)]"
        >
          <Check className="size-4" aria-hidden /> Saved
        </span>
      )}
      {dirty && !saving && <span className="text-caption text-muted">Unsaved changes</span>}
    </div>
  );
}
