import { loadEnv } from '../../src/config/env';
import { type JobHandlers, RetryJob } from '../../src/jobs/job-handlers.service';
import { JobWorker } from '../../src/jobs/job-worker.service';
import type { PgBossTransport } from '../../src/jobs/pg-boss.service';
import { JOB_QUEUES, JOB_SCHEDULE } from '../../src/jobs/queues';
import { isGsm7, smsBodyFor, smsSegments, trackingUrl } from '../../src/jobs/sms';

const BASE = { DJANGO_SECRET_KEY: 'unit-test-key', DATABASE_URL: 'postgresql://x/y' };
const EMAIL = 'notifications.tasks.send_order_email';
const SWEEP = 'orders.tasks.release_expired_reservations';

describe('the worker settings', () => {
  it('fires the schedule in a worker unless told not to, and never outside one', () => {
    expect(loadEnv({ ...BASE, RANGON_JOBS_BACKEND: 'pgboss' }).jobsSchedule).toBe(true);
    expect(
      loadEnv({ ...BASE, RANGON_JOBS_BACKEND: 'pgboss', RANGON_JOBS_SCHEDULE: '0' }).jobsSchedule,
    ).toBe(false);
    const apiOnly = loadEnv({ ...BASE, RANGON_JOBS_BACKEND: 'pgboss', RANGON_JOBS_WORKER: '0' });
    expect(apiOnly.jobsSchedule).toBe(false);
    expect(loadEnv(BASE).jobsSchedule).toBe(false);
  });
});

describe('JobWorker', () => {
  type Deliver = (jobs: { data: { args?: unknown[] } }[]) => Promise<unknown>;
  const make = (settings: Record<string, string> = {}) => {
    const run = jest.fn<Promise<string>, [string, unknown[]]>();
    const boss = {
      work: jest.fn<Promise<string>, [string, unknown, Deliver]>().mockResolvedValue('worker-id'),
      schedule: jest.fn().mockResolvedValue(undefined),
    };
    const pgBoss = { start: jest.fn().mockResolvedValue(boss) };
    const worker = new JobWorker(
      { run } as unknown as JobHandlers,
      pgBoss as unknown as PgBossTransport,
      loadEnv({ ...BASE, RANGON_JOBS_BACKEND: 'pgboss', ...settings }),
    );
    // Its failures are logged; a test need not print them.
    jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    return { worker, run, boss, pgBoss };
  };

  it('does nothing in a process that is not a worker: pg-boss is not even started', async () => {
    const { worker, pgBoss } = make({ RANGON_JOBS_WORKER: '0' });
    await worker.onApplicationBootstrap();
    expect(pgBoss.start).not.toHaveBeenCalled();
  });

  it("works every queue and schedules beat's five lines on the shop's clock", async () => {
    const { worker, boss } = make({ DJANGO_TIME_ZONE: 'Asia/Dhaka' });
    await worker.onApplicationBootstrap();
    expect(boss.work.mock.calls.map(([task]) => task).sort()).toEqual(
      Object.keys(JOB_QUEUES).sort(),
    );
    expect(boss.schedule.mock.calls).toEqual(
      JOB_SCHEDULE.map(({ task, cron }) => [task, cron, { args: [] }, { tz: 'Asia/Dhaka' }]),
    );
  });

  it('works the queues and schedules nothing when the schedule is left to beat', async () => {
    const { worker, boss } = make({ RANGON_JOBS_SCHEDULE: '0' });
    await worker.onApplicationBootstrap();
    expect(boss.work).toHaveBeenCalledTimes(Object.keys(JOB_QUEUES).length);
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("hands a delivery's arguments to the handler and its word back to the row", async () => {
    const { worker, run, boss } = make();
    await worker.onApplicationBootstrap();
    const deliver = boss.work.mock.calls.find(([task]) => task === EMAIL)?.[2] as Deliver;
    run.mockResolvedValueOnce('sent');
    await expect(deliver([{ data: { args: ['order-1', 'ORDER_SHIPPED'] } }])).resolves.toEqual({
      result: 'sent',
    });
    expect(run).toHaveBeenCalledWith(EMAIL, ['order-1', 'ORDER_SHIPPED']);
    // A scheduled job carries no arguments worth the name.
    run.mockResolvedValueOnce('released:0');
    const sweep = boss.work.mock.calls.find(([task]) => task === SWEEP)?.[2] as Deliver;
    await expect(sweep([{ data: {} }])).resolves.toEqual({ result: 'released:0' });
    expect(run).toHaveBeenLastCalledWith(SWEEP, []);
  });

  it('raises a fault its task retries, for the queue to deliver the job again', async () => {
    const { worker, run } = make();
    const fault = new Error('connect ECONNREFUSED');
    run.mockRejectedValueOnce(new RetryJob(fault));
    await expect(worker.work(EMAIL, ['order-1', 'ORDER_SHIPPED'])).rejects.toBe(fault);
    run.mockRejectedValueOnce(new RetryJob('550 refused'));
    await expect(worker.work(EMAIL, ['order-1', 'ORDER_SHIPPED'])).rejects.toThrow('550 refused');
  });

  it('closes a job that failed any other way, with the reason, so it is not delivered again', async () => {
    const { worker, run } = make();
    run.mockRejectedValueOnce(new Error('No handler for the job x.'));
    await expect(worker.work(EMAIL, [])).resolves.toEqual({
      result: null,
      error: 'No handler for the job x.',
    });
  });

  describe('apply, the eager run the parity stack compares with', () => {
    it('answers the word of a job that succeeds', async () => {
      const { worker, run } = make();
      run.mockResolvedValueOnce('sent');
      await expect(worker.apply(EMAIL, ['order-1'])).resolves.toEqual({
        state: 'SUCCESS',
        result: 'sent',
      });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('tries a sender once and then as often again as its task retries', async () => {
      const { worker, run } = make();
      run.mockRejectedValue(new RetryJob(new Error('refused')));
      await expect(worker.apply(EMAIL, ['order-1'])).resolves.toEqual({
        state: 'FAILURE',
        result: null,
      });
      expect(run).toHaveBeenCalledTimes(1 + (JOB_QUEUES[EMAIL]?.retryLimit ?? 0));
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('stops at the attempt that succeeds', async () => {
      const { worker, run } = make();
      run.mockRejectedValueOnce(new RetryJob(new Error('refused'))).mockResolvedValueOnce('sent');
      await expect(worker.apply(EMAIL, ['order-1'])).resolves.toEqual({
        state: 'SUCCESS',
        result: 'sent',
      });
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('fails at once on anything its task does not retry, and a job that never retries on anything', async () => {
      const { worker, run } = make();
      run.mockRejectedValueOnce(new Error('boom'));
      await expect(worker.apply(EMAIL, ['order-1'])).resolves.toEqual({
        state: 'FAILURE',
        result: null,
      });
      expect(run).toHaveBeenCalledTimes(1);
      run.mockClear();
      run.mockRejectedValue(new RetryJob(new Error('refused')));
      await expect(worker.apply(SWEEP, [])).resolves.toEqual({ state: 'FAILURE', result: null });
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * `notifications.sms`, against what Django printed for the same input
 * (`is_gsm7`, `segments`, `body_for`) in the parity stack's Django container.
 */
describe('the SMS arithmetic and wording', () => {
  const DJANGO: [body: string, gsm7: boolean, segments: number][] = [
    ['', true, 0],
    ['a', true, 1],
    ['a'.repeat(160), true, 1],
    ['a'.repeat(161), true, 2],
    ['a'.repeat(306), true, 2],
    ['a'.repeat(307), true, 3],
    // The extension table: two characters each.
    ['^'.repeat(80), true, 1],
    ['^'.repeat(81), true, 2],
    ['€uro {x} [y] ~|\\', true, 1],
    [`${'A'.repeat(153)}€`, true, 1],
    [`${'A'.repeat(152)}€€€€`, true, 1],
    // One character outside the alphabet makes the whole message UCS-2.
    ['অ', false, 1],
    ['অ'.repeat(70), false, 1],
    ['অ'.repeat(71), false, 2],
    ['অ'.repeat(134), false, 2],
    ['অ'.repeat(135), false, 3],
    // Counted as Python counts: code points, not UTF-16 units.
    ['😀'.repeat(70), false, 1],
    ['😀'.repeat(71), false, 2],
    ['Rangon: order RGN-1 confirmed’', false, 1],
    ['line\nbreak\r', true, 1],
    ['ñ ü à Ç ç', false, 1],
    ['¤ § ¿ Δ Ω', true, 1],
    ['tab\there', false, 1],
  ];

  it.each(DJANGO)('%j: GSM-7 %s, %i segment(s)', (body, gsm7, segments) => {
    expect(isGsm7(body)).toBe(gsm7);
    expect(smsSegments(body)).toBe(segments);
  });

  const order = {
    number: 'RGN-20261007-0042',
    currency: 'BDT',
    grand_total: '1290.00',
    refunded_total: '300.00',
  };
  const LINK = 'https://shop.rangon.test/order/RGN-20261007-0042';
  const BODIES: [publicUrl: string, type: string, body: string][] = [
    [
      'https://shop.rangon.test',
      'ORDER_CONFIRMED',
      `Rangon: order RGN-20261007-0042 confirmed, BDT 1290.00. ${LINK}`,
    ],
    [
      'https://shop.rangon.test',
      'ORDER_SHIPPED',
      `Rangon: order RGN-20261007-0042 is on its way. Please keep your phone nearby. ${LINK}`,
    ],
    ['https://shop.rangon.test', 'ORDER_DELIVERED', ''],
    [
      'https://shop.rangon.test',
      'REFUND_COMPLETED',
      'Rangon: refund issued for order RGN-20261007-0042, BDT 300.00.',
    ],
    ['https://shop.rangon.test', '', ''],
    // No template by a name every object has.
    ['https://shop.rangon.test', 'constructor', ''],
    ['https://shop.rangon.test', 'toString', ''],
    [
      'https://shop.rangon.test///',
      'ORDER_CONFIRMED',
      `Rangon: order RGN-20261007-0042 confirmed, BDT 1290.00. ${LINK}`,
    ],
    // With no origin to put before it there is no link, and no space left for one.
    ['', 'ORDER_CONFIRMED', 'Rangon: order RGN-20261007-0042 confirmed, BDT 1290.00.'],
    [
      '',
      'ORDER_SHIPPED',
      'Rangon: order RGN-20261007-0042 is on its way. Please keep your phone nearby.',
    ],
    ['', 'REFUND_COMPLETED', 'Rangon: refund issued for order RGN-20261007-0042, BDT 300.00.'],
  ];

  it.each(BODIES)('with the shop at %j, %s reads as Django has it', (publicUrl, type, body) => {
    expect(smsBodyFor(order, type, publicUrl)).toBe(body);
  });

  it('writes every template into one segment', () => {
    for (const [publicUrl, type] of BODIES) {
      const body = smsBodyFor(order, type, publicUrl);
      if (body) expect(smsSegments(body)).toBe(1);
    }
  });

  it('links an order from the public origin, whatever slashes it ends in', () => {
    expect(trackingUrl(order, 'https://shop.rangon.test/')).toBe(LINK);
    expect(trackingUrl(order, '')).toBe('');
  });
});
