import { loadEnv } from '../../src/config/env';
import type { Queryable } from '../../src/database/database.service';
import { Jobs } from '../../src/jobs/jobs.service';
import type { PgBossTransport } from '../../src/jobs/pg-boss.service';
import { JOB_QUEUES, JOB_SCHEDULE, JOB_TIME_LIMIT_SECONDS } from '../../src/jobs/queues';

const BASE = { DJANGO_SECRET_KEY: 'unit-test-key', DATABASE_URL: 'postgresql://x/y' };

/**
 * What Celery itself reports, printed in the Django container: every
 * registered task with the `max_retries` and `default_retry_delay` it retries
 * with (nothing for a task that never calls `self.retry`), `beat_schedule`,
 * `CELERY_TIMEZONE` and `CELERY_TASK_TIME_LIMIT`.
 */
const CELERY = {
  tasks: {
    'catalog.tasks.check_expiring_stock': { retryLimit: 0, retryDelay: 0 },
    'content.tasks.revalidate_storefront': { retryLimit: 2, retryDelay: 30 },
    'inventory.tasks.notify_low_stock': { retryLimit: 0, retryDelay: 0 },
    'inventory.tasks.send_low_stock_digest': { retryLimit: 0, retryDelay: 0 },
    'inventory.tasks.verify_inventory_integrity': { retryLimit: 0, retryDelay: 0 },
    'notifications.tasks.send_notification_email': { retryLimit: 3, retryDelay: 60 },
    'notifications.tasks.send_order_email': { retryLimit: 3, retryDelay: 120 },
    'notifications.tasks.send_order_sms': { retryLimit: 3, retryDelay: 120 },
    'orders.tasks.expire_abandoned_carts': { retryLimit: 0, retryDelay: 0 },
    'orders.tasks.release_expired_reservations': { retryLimit: 0, retryDelay: 0 },
  },
  schedule: [
    { task: 'orders.tasks.release_expired_reservations', cron: '*/5 * * * *' },
    { task: 'inventory.tasks.verify_inventory_integrity', cron: '30 1 * * *' },
    { task: 'inventory.tasks.send_low_stock_digest', cron: '0 8 * * *' },
    { task: 'orders.tasks.expire_abandoned_carts', cron: '0 3 * * *' },
    { task: 'catalog.tasks.check_expiring_stock', cron: '15 8 * * *' },
  ],
  limit: 600,
};

describe('the background jobs', () => {
  it('has a queue for every Celery task, with the retries that task declares', () => {
    expect(JOB_QUEUES).toEqual(CELERY.tasks);
  });

  it('fires what beat fires, when beat fires it', () => {
    expect(JOB_SCHEDULE).toEqual(CELERY.schedule);
    expect(JOB_TIME_LIMIT_SECONDS).toBe(CELERY.limit);
    for (const { task } of JOB_SCHEDULE) expect(Object.hasOwn(JOB_QUEUES, task)).toBe(true);
  });
});

describe('where jobs are worked', () => {
  it('works its own queue with pg-boss, unless a separate worker does', () => {
    expect(loadEnv(BASE).jobsWorker).toBe(true);
    expect(loadEnv({ ...BASE, RANGON_JOBS_WORKER: '0' }).jobsWorker).toBe(false);
    expect(loadEnv({ ...BASE, RANGON_JOBS_WORKER: ' ' }).jobsWorker).toBe(true);
    expect(loadEnv({ ...BASE, RANGON_JOBS_WORKER: '1' }).jobsWorker).toBe(true);
  });
});

describe('Jobs', () => {
  const tx = { query: jest.fn(), one: jest.fn() } as unknown as Queryable;
  const make = () => {
    const pgBoss = { send: jest.fn().mockResolvedValue(undefined) };
    const jobs = new Jobs(pgBoss as unknown as PgBossTransport);
    return { jobs, pgBoss };
  };

  it('writes a job decided in a transaction in that transaction', async () => {
    const { jobs, pgBoss } = make();
    await jobs.delayIn(tx, 'inventory.tasks.notify_low_stock', ['row-1']);
    expect(pgBoss.send).toHaveBeenCalledWith('inventory.tasks.notify_low_stock', ['row-1'], tx);
  });

  it('a job that cannot be written fails the transaction it belongs to', async () => {
    const { jobs, pgBoss } = make();
    pgBoss.send.mockRejectedValueOnce(new Error('relation "pgboss.job" does not exist'));
    await expect(jobs.delayIn(tx, 'inventory.tasks.notify_low_stock', ['row-1'])).rejects.toThrow(
      'pgboss.job',
    );
  });

  it('outside a transaction, queues at once and never raises', async () => {
    const { jobs, pgBoss } = make();
    pgBoss.send.mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      jobs.delay('content.tasks.revalidate_storefront', [['site']]),
    ).resolves.toBeUndefined();
    expect(pgBoss.send).toHaveBeenCalledWith('content.tasks.revalidate_storefront', [['site']]);
  });
});
