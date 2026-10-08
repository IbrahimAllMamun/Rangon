/**
 * The background jobs, by the name of the Celery task each replaces, with
 * the retry policy that task declares (`max_retries`, `default_retry_delay`).
 * A plain `@shared_task` is never retried.
 *
 * Under pg-boss a queue carries the task's name, so a job queued through
 * either transport is the same pair: a name and its positional arguments.
 */
export interface QueuePolicy {
  /** Celery's `max_retries`: attempts after the first. */
  retryLimit: number;
  /** Celery's `default_retry_delay`, in seconds; never backed off. */
  retryDelay: number;
}

const NEVER: QueuePolicy = { retryLimit: 0, retryDelay: 0 };

export const JOB_QUEUES: Readonly<Record<string, QueuePolicy>> = {
  'content.tasks.revalidate_storefront': { retryLimit: 2, retryDelay: 30 },
  'notifications.tasks.send_notification_email': { retryLimit: 3, retryDelay: 60 },
  'notifications.tasks.send_order_email': { retryLimit: 3, retryDelay: 120 },
  'notifications.tasks.send_order_sms': { retryLimit: 3, retryDelay: 120 },
  'inventory.tasks.notify_low_stock': NEVER,
  'orders.tasks.release_expired_reservations': NEVER,
  'orders.tasks.expire_abandoned_carts': NEVER,
  'inventory.tasks.verify_inventory_integrity': NEVER,
  'inventory.tasks.send_low_stock_digest': NEVER,
  'catalog.tasks.check_expiring_stock': NEVER,
};

/** `CELERY_TASK_TIME_LIMIT`: ten minutes, after which a job is taken to have died. */
export const JOB_TIME_LIMIT_SECONDS = 600;

/**
 * `app.conf.beat_schedule` in `config/celery.py`: five lines, read on the
 * shop's clock (`CELERY_TIMEZONE = TIME_ZONE`).
 */
export const JOB_SCHEDULE: readonly { task: string; cron: string }[] = [
  { task: 'orders.tasks.release_expired_reservations', cron: '*/5 * * * *' },
  { task: 'inventory.tasks.verify_inventory_integrity', cron: '30 1 * * *' },
  { task: 'inventory.tasks.send_low_stock_digest', cron: '0 8 * * *' },
  { task: 'orders.tasks.expire_abandoned_carts', cron: '0 3 * * *' },
  { task: 'catalog.tasks.check_expiring_stock', cron: '15 8 * * *' },
];
