import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { ENV, Env } from '../config/env';
import { ErrorReports } from '../observability/error-reports.service';
import { JobHandlers, RetryJob } from './job-handlers.service';
import { PgBossTransport } from './pg-boss.service';
import { JOB_QUEUES, JOB_SCHEDULE } from './queues';

/** What a job came to, in Celery's words. */
export interface JobOutcome {
  state: 'SUCCESS' | 'FAILURE';
  result: string | null;
}

/** What a delivery leaves on its row, in `pgboss.job.output`. */
export interface JobOutput {
  /** The word the task returns; null when it failed. */
  result: string | null;
  /** Why it failed, when it did and is not to be tried again. */
  error?: string;
}

/**
 * Runs the jobs (ADR-0016): the handlers on the pg-boss queues, and the
 * schedule that `config/celery.py` gives beat, in the shop's time zone.
 * Only in a process told to (`RANGON_JOBS_WORKER`): by default the API
 * process itself with the pg-boss backend, never with Celery's. The
 * schedule can be left to beat (`RANGON_JOBS_SCHEDULE=0`) while both run.
 */
@Injectable()
export class JobWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('rangon.jobs');

  constructor(
    private readonly handlers: JobHandlers,
    private readonly pgBoss: PgBossTransport,
    private readonly reports: ErrorReports,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.jobsWorker) return;
    const boss = await this.pgBoss.start();
    for (const task of Object.keys(JOB_QUEUES)) {
      // One job at a delivery: what the handler answers is that job's output.
      await boss.work<{ args?: unknown[] }>(task, { pollingIntervalSeconds: 2 }, async (jobs) => {
        let output: JobOutput = { result: null };
        for (const job of jobs) {
          output = await this.work(task, job.data.args ?? [], job.retryCount);
        }
        return output;
      });
    }
    if (this.env.jobsSchedule) {
      for (const { task, cron } of JOB_SCHEDULE) {
        await boss.schedule(task, cron, { args: [] }, { tz: this.env.DJANGO_TIME_ZONE });
      }
    }
    this.logger.log(
      `Working ${Object.keys(JOB_QUEUES).length} queues; ` +
        (this.env.jobsSchedule
          ? `${JOB_SCHEDULE.length} jobs scheduled.`
          : 'the schedule is left to another process.'),
    );
  }

  /**
   * One delivery of a job; `retries` is how many times it has been delivered
   * before. A fault its task retries is raised, for pg-boss to deliver the
   * job again as often and as far apart as the queue says. Any other failure
   * is logged and the job closed, with the reason on its row: Celery fails
   * such a task once and does not run it again.
   *
   * A failure that will not be tried again is reported (ADR-0019): the kind
   * that is never retried, at once; the kind that is, on the delivery that
   * spends its last retry. The attempts in between are not errors yet.
   */
  async work(task: string, args: unknown[], retries = 0): Promise<JobOutput> {
    try {
      return { result: await this.handlers.run(task, args) };
    } catch (error) {
      if (error instanceof RetryJob) {
        const fault = error.fault instanceof Error ? error.fault : new Error(String(error.fault));
        if (retries >= (JOB_QUEUES[task]?.retryLimit ?? 0)) {
          this.reports.job(fault, task, retries + 1);
        }
        throw fault;
      }
      this.logger.error(
        `The job ${task} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      this.reports.job(error, task, retries + 1);
      return { result: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * `task.apply(args=...)`, Celery's eager run: the job now, and every retry
   * its task allows at once. What the parity stack compares with.
   */
  async apply(task: string, args: unknown[]): Promise<JobOutcome> {
    const attempts = 1 + (JOB_QUEUES[task]?.retryLimit ?? 0);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return { state: 'SUCCESS', result: await this.handlers.run(task, args) };
      } catch (error) {
        if (!(error instanceof RetryJob)) {
          this.logger.error(`The job ${task} failed: ${String(error)}`);
          return { state: 'FAILURE', result: null };
        }
      }
    }
    return { state: 'FAILURE', result: null };
  }
}
