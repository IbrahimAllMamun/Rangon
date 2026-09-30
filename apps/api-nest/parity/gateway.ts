/**
 * The Nest twin of `gateway/parity_gateway/apps.py`: a stand-in payment
 * gateway whose signature check has passed -- it believes the body. Registered
 * by serve.ts, in the parity stack only, so a webhook can reach the capture
 * path the way it does in Django with its twin installed.
 *
 * It reads the body as Python's `json.loads` does (ints and floats kept apart)
 * and the amount as `Decimal(...)` of a string or an int. The harness sends
 * nothing else; anything else is refused, which both twins answer with a 500.
 */
const DIST = '../dist';

interface Dist {
  parsePythonJson(text: string): unknown;
  pyDecimal(text: string): string | null;
  Dec: new (value: string) => unknown;
}

async function load(): Promise<Dist> {
  const [body, python, decimal] = await Promise.all([
    import(`${DIST}/http/request-body.js`),
    import(`${DIST}/common/python.js`),
    import(`${DIST}/common/decimal.js`),
  ]);
  return {
    parsePythonJson: (body as Dist).parsePythonJson,
    pyDecimal: (python as Dist).pyDecimal,
    Dec: (decimal as Dist).Dec,
  };
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parityGateway() {
  const dist = await load();
  const decimal = (value: unknown): unknown => {
    const text =
      typeof value === 'string'
        ? dist.pyDecimal(value)
        : Number.isInteger(value) || typeof value === 'bigint'
          ? String(value)
          : null;
    if (text === null) throw new Error(`[<class 'decimal.ConversionSyntax'>]`);
    return new dist.Dec(text);
  };
  return {
    code: 'paritypay',
    label: 'Parity stand-in gateway',
    parseWebhook(body: Buffer) {
      let data: unknown;
      try {
        data = dist.parsePythonJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch (error) {
        // `json.loads` raises JSONDecodeError, which no view catches: a 500.
        throw new Error(`JSONDecodeError: ${(error as Error).message}`, { cause: error });
      }
      if (!isDict(data)) throw new TypeError('list indices must be integers or slices, not str');
      for (const key of ['event_id', 'event_type']) {
        if (!Object.hasOwn(data, key)) throw new Error(`KeyError: '${key}'`);
      }
      return {
        eventId: data.event_id,
        eventType: data.event_type,
        orderNumber: Object.hasOwn(data, 'order_number') ? data.order_number : '',
        reference: '',
        amount: Object.hasOwn(data, 'amount') ? decimal(data.amount) : null,
        raw: data,
      };
    },
  };
}
