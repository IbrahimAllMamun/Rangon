import { errorMessages, integerField, listField, runSerializer } from '../../src/common/drf';

/**
 * `serializers.ListField(child=..., min_length=, max_length=)`. The messages
 * are the ones the Django API answered with for the label sheet's `marks`.
 */
describe('listField with a length', () => {
  const fields = { marks: listField(integerField(), { minLength: 1, maxLength: 3 }) };
  const run = async (data: unknown) => {
    const result = await runSerializer(fields, data);
    return result.ok ? result.values : errorMessages(result.errors);
  };

  it('takes a list within its bounds', async () => {
    expect(await run({ marks: [1] })).toEqual({ marks: [1] });
    expect(await run({ marks: [1, 2, 3] })).toEqual({ marks: [1, 2, 3] });
  });

  it('refuses one too short', async () => {
    expect(await run({ marks: [] })).toEqual({
      marks: ['Ensure this field has at least 1 elements.'],
    });
  });

  it('refuses one too long', async () => {
    expect(await run({ marks: [1, 2, 3, 4] })).toEqual({
      marks: ['Ensure this field has no more than 3 elements.'],
    });
  });

  it('reports the items before the length', async () => {
    expect(await run({ marks: [1, 'x', 3, 4] })).toEqual({
      marks: { '1': ['A valid integer is required.'] },
    });
  });
});
