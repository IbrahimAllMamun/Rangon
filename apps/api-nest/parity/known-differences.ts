/**
 * Differences between the two APIs that are deliberate, each with its reason.
 * Every entry here is also listed in docs/architecture/nest-port.md; a
 * difference not matched here fails the parity run.
 */
import type { Difference } from './compare.ts';
import type { Case } from './run.ts';

export interface KnownDifference {
  reason: string;
  appliesTo(testCase: Case, difference: Difference): boolean;
}

export const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    reason:
      "401 message: Django prints the Python repr of SimpleJWT's error dict " +
      '("{\'detail\': ErrorDetail(string=...") -- the Nest API sends the words inside it. Status and code match.',
    appliesTo: (_testCase, difference) =>
      difference.path === '$.error.message' &&
      typeof difference.django === 'string' &&
      difference.django.startsWith("{'detail': ErrorDetail("),
  },
];
