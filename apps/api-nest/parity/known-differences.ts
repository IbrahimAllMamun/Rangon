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
  {
    reason:
      'Malformed JSON body: both answer 400 VALIDATION_ERROR with "JSON parse error - " and the parser\'s ' +
      "own explanation, which is Python's json module's wording on one side and V8's on the other.",
    appliesTo: (_testCase, difference) =>
      difference.path === '$.error.message' &&
      typeof difference.django === 'string' &&
      typeof difference.nest === 'string' &&
      difference.django.startsWith('JSON parse error - ') &&
      difference.nest.startsWith('JSON parse error - '),
  },
];
