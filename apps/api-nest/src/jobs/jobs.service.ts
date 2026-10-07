import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV, Env } from '../config/env';
import type { Queryable } from '../database/database.service';
import { CeleryService } from './celery.service';
import { PgBossTransport } from './pg-boss.service';

/** A job: the Celery task it stands for, and that task's positional arguments. */
export interface QueuedJob {
  task: string;
  args: unknown[];
}

/**
 * Where background work is handed over, and the one place the transport is
 * chosen (`RANGON_JOBS_BACKEND`, ADR-0016):
 *
 * - `celery`, the default until the cutover: Celery's own message into
 *   Django's broker, for Django's worker (ADR-0014). A broker cannot take part
 *   in a transaction, so a job decided inside one is sent once it commits --
 *   Django's `transaction.on_commit`.
 * - `pgboss`: a row in PostgreSQL. A job decided inside a transaction is
 *   written in it, and commits or rolls back with the work that queued it.
 */
@Injectable()
export class Jobs {
  private readonly logger = new Logger('rangon.jobs');

  constructor(
    private readonly celery: CeleryService,
    private readonly pgBoss: PgBossTransport,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Whether a job can be written inside the transaction that decides it. */
  get transactional(): boolean {
    return this.env.RANGON_JOBS_BACKEND === 'pgboss';
  }

  /**
   * Queue a job with no transaction around it. Best effort, as
   * `task.delay()` is where Django calls it after a commit: a failure is
   * logged, never raised, because the work it follows is already done.
   */
  async delay(task: string, args: unknown[]): Promise<void> {
    if (!this.transactional) return this.celery.delay(task, args);
    try {
      await this.pgBoss.send(task, args);
    } catch (error) {
      this.logger.error(`Could not queue ${task}: ${String(error)}`);
    }
  }

  /**
   * Queue a job decided inside `tx`. With pg-boss it is written now, in
   * that transaction, and a failure fails the transaction. With Celery it
   * is added to `afterCommit`, for the caller to run once it has committed.
   */
  async delayIn(
    tx: Queryable,
    afterCommit: (() => Promise<void>)[],
    task: string,
    args: unknown[],
  ): Promise<void> {
    if (this.transactional) await this.pgBoss.send(task, args, tx);
    else afterCommit.push(() => this.celery.delay(task, args));
  }
}
