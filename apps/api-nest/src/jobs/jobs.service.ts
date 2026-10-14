import { Injectable, Logger } from '@nestjs/common';

import type { Queryable } from '../database/database.service';
import { PgBossTransport } from './pg-boss.service';

/** A job: the task it stands for, and that task's positional arguments. */
export interface QueuedJob {
  task: string;
  args: unknown[];
}

/**
 * Where background work is handed over: a row in PostgreSQL, through pg-boss
 * (ADR-0016). A job decided inside a transaction is written in it, and
 * commits or rolls back with the work that queued it. Celery's broker, the
 * other transport until Django went (ADR-0014), is gone with it.
 */
@Injectable()
export class Jobs {
  private readonly logger = new Logger('rangon.jobs');

  constructor(private readonly pgBoss: PgBossTransport) {}

  /**
   * Queue a job with no transaction around it. Best effort, as
   * `task.delay()` was where Django called it after a commit: a failure is
   * logged, never raised, because the work it follows is already done.
   */
  async delay(task: string, args: unknown[]): Promise<void> {
    try {
      await this.pgBoss.send(task, args);
    } catch (error) {
      this.logger.error(`Could not queue ${task}: ${String(error)}`);
    }
  }

  /**
   * Queue a job decided inside `tx`: written now, in that transaction, and a
   * failure fails the transaction.
   */
  async delayIn(tx: Queryable, task: string, args: unknown[]): Promise<void> {
    await this.pgBoss.send(task, args, tx);
  }
}
