import { Invalid } from '../../src/common/drf';
import { cleanCities, etaLabel } from '../../src/shipping/shipping-settings.service';

/**
 * Shipping settings. Every expected value was printed by Django itself
 * (`ShippingZoneSerializer().validate_cities`, `ShippingMethod.eta_label`),
 * in the parity stack.
 */
describe('cleanCities (validate_cities)', () => {
  it.each([
    [
      [' Rajshahi ', 'RAJSHAHI', '', 'Bogura', 'bogura '],
      ['rajshahi', 'bogura'],
    ],
    [[], []],
    [['', '   '], []],
    [
      ['ঢাকা', ' ঢাকা', 'İstanbul', 'STRASSE', 'Straße', 'ǅ'],
      ['ঢাকা', 'i̇stanbul', 'strasse', 'straße', 'ǆ'],
    ],
    // A no-break space is space to Python; a zero-width space is not.
    [
      [' Dhaka ', '\tSylhet\n', '​X'],
      ['dhaka', 'sylhet', '​x'],
    ],
    [
      ['a', 'A', 'b', 'a '],
      ['a', 'b'],
    ],
  ])('%j is stored as %j', (value, stored) => {
    expect(cleanCities(value)).toEqual(stored);
  });

  const refusal = (value: unknown): string => {
    try {
      cleanCities(value);
    } catch (error) {
      if (error instanceof Invalid) return error.details[0]?.message ?? '';
      throw error;
    }
    return 'accepted';
  };
  const NOT_A_LIST = 'Provide a list of city names, e.g. ["dhaka", "gazipur"].';
  const NOT_A_NAME = 'Every city must be a name.';

  it.each([
    ['dhaka', NOT_A_LIST],
    [{ dhaka: true }, NOT_A_LIST],
    [7, NOT_A_LIST],
    [null, NOT_A_LIST],
    [true, NOT_A_LIST],
    [['dhaka', 4000], NOT_A_NAME],
    [['dhaka', null], NOT_A_NAME],
    [[['dhaka']], NOT_A_NAME],
  ])('%j is refused: %s', (value, message) => {
    expect(refusal(value)).toBe(message);
  });
});

describe('etaLabel (ShippingMethod.eta_label)', () => {
  it.each([
    [true, 0, 1, 'Collect in store'],
    [true, 5, 2, 'Collect in store'],
    [false, 1, 1, '1 day'],
    [false, 0, 0, '0 days'],
    [false, 2, 2, '2 days'],
    [false, 1, 3, '1–3 days'],
    [false, 0, 1, '0–1 days'],
    // The table refuses this one; the label does not.
    [false, 5, 2, '5–2 days'],
    [false, 10, 14, '10–14 days'],
  ])('pickup %j, %i to %i days: %s', (isPickup, min, max, label) => {
    expect(etaLabel({ is_pickup: isPickup, min_days: min, max_days: max })).toBe(label);
  });
});
