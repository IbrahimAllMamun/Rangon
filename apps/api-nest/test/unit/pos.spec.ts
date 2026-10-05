/**
 * The counter's building blocks against Django's own answers. Every expected
 * value was printed by the Django API's container (Django 5.1, DRF 3.15),
 * not worked out by hand.
 */
import { errorMessages, jsonField, runSerializer } from '../../src/common/drf';
import { installBigIntJson, parsePythonJson } from '../../src/http/request-body';

describe('JSONField(required=False), as a held sale reads its payload', () => {
  beforeAll(() => installBigIntJson());
  const fields = { payload: jsonField({ required: false }) };
  const run = async (text: string) => {
    const result = await runSerializer(fields, parsePythonJson(text));
    return JSON.stringify(result.ok ? result.values : errorMessages(result.errors));
  };

  it.each([
    ['{}', '{}'],
    ['{"payload": null}', '{"payload":["This field may not be null."]}'],
    // A float past a double is read as infinity, which `allow_nan=False` refuses.
    ['{"payload": 1e400}', '{"payload":["Value must be valid JSON."]}'],
    ['{"payload": {"a": [1, -1e999]}}', '{"payload":["Value must be valid JSON."]}'],
    // Floats keep Python's form and a long integer its digits, on the way to jsonb.
    [
      '{"payload": {"a": 1.0, "b": [1e3, 12345678901234567890]}}',
      '{"payload":{"a":1.0,"b":[1000.0,12345678901234567890]}}',
    ],
    ['{"payload": "x"}', '{"payload":"x"}'],
    ['{"payload": false}', '{"payload":false}'],
    ['{"payload": []}', '{"payload":[]}'],
  ])('%s', async (body, expected) => {
    expect(await run(body)).toBe(expected);
  });
});
