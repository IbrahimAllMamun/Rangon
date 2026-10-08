import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { PgBoss } from 'pg-boss';

import { ENV, Env } from '../config/env';
import type { Queryable } from '../database/database.service';
import { JOB_QUEUES, JOB_TIME_LIMIT_SECONDS } from './queues';

/** The PostgreSQL schema pg-boss owns: its tables, and nothing of Django's (ADR-0016). */
export const JOBS_SCHEMA = 'pgboss';

/**
 * The pg-boss queue (ADR-0016): a job is a row, and a row can be written in
 * the transaction that decides it.
 *
 * Started only when `RANGON_JOBS_BACKEND=pgboss` -- the default backend
 * creates no schema and opens no second pool. Starting it creates or
 * migrates the `pgboss` schema and makes sure every queue is there, with the
 * retry policy its Celery task had.
 */
@Injectable()
export class PgBossTransport implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('rangon.jobs');
  private boss: PgBoss | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return this.env.RANGON_JOBS_BACKEND === 'pgboss';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) await this.start();
  }

  /** The started instance; `start()` first. */
  instance(): PgBoss {
    if (!this.boss) throw new Error('pg-boss has not been started.');
    return this.boss;
  }

  async start(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    // pg-boss is an ES module; loaded here so nothing pays for it, or needs
    // it, with the default backend.
    const { PgBoss: Boss } = await import('pg-boss');
    const boss = new Boss({
      connectionString: this.env.DATABASE_URL,
      schema: JOBS_SCHEMA,
      application_name: 'rangon-api-nest-jobs',
      // Its own small pool: polling, maintenance and the schedule's clock.
      max: 4,
      // Only a worker supervises the queues, and fires the schedule unless
      // told not to: an API-only process queues, and reads nothing.
      schedule: this.env.jobsSchedule,
      supervise: this.env.jobsWorker,
    });
    boss.on('error', (error: Error) => this.logger.error(`pg-boss: ${error.message}`));
    await boss.start();
    for (const [name, policy] of Object.entries(JOB_QUEUES)) {
      await boss.createQueue(name, {
        retryLimit: policy.retryLimit,
        retryDelay: policy.retryDelay,
        retryBackoff: false,
        expireInSeconds: JOB_TIME_LIMIT_SECONDS,
      });
    }
    this.boss = boss;
    return boss;
  }

  /**
   * Queue a job: in `tx`, as a row of the caller's transaction, or at once
   * through pg-boss's own pool. Raises on failure -- inside a transaction
   * that is the point: the work and its job commit together or not at all.
   */
  async send(task: string, args: unknown[], tx?: Queryable): Promise<void> {
    if (!Object.hasOwn(JOB_QUEUES, task)) throw new Error(`No queue for the job ${task}.`);
    await this.instance().send(
      task,
      { args },
      tx
        ? {
            db: {
              executeSql: async (text: string, values?: unknown[]) => ({
                rows: await tx.query(text, values ?? []),
              }),
            },
          }
        : {},
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
  }
}
