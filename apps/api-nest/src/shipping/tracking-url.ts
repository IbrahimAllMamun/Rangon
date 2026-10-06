import { pyFormatNamed, PyLookupError } from '../common/python';

/**
 * `Shipment.tracking_url` as a serializer reads it: nothing without a
 * courier, a template and a number, and otherwise the courier's template
 * with the number in it. A template naming a field it is not given, or an
 * attribute, raises a KeyError or an AttributeError, which DRF takes to mean
 * a read-only field is not there: the answer then has no `tracking_url` at
 * all (`undefined`, which JSON leaves out). Anything else Python raises -- a
 * stray brace, a numbered field -- is the 500 it is in Django.
 */
export function trackingUrl(
  courierId: string | null,
  template: string | null,
  trackingNumber: string,
): string | undefined {
  if (!courierId || !template || !trackingNumber) return '';
  try {
    return pyFormatNamed(template, { tracking_number: trackingNumber });
  } catch (error) {
    if (error instanceof PyLookupError) return undefined;
    throw error;
  }
}
