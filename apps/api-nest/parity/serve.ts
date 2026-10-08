/**
 * The Nest API as the parity stack runs it (docker-compose.nest.yml): the
 * image's own application, with the stand-in payment gateway registered before
 * it listens (gateway.ts), and three routes about background jobs: run one
 * on demand, queue one, and say what is scheduled. The image's command,
 * `node dist/main.js`, has none of them and never loads this directory.
 */
import { parityGateway } from './gateway.ts';

interface Outcome {
  state: string;
  result: string | null;
}

type Handler = (
  request: { body?: { bytes?: Buffer } },
  reply: { send(payload: unknown): unknown },
) => Promise<unknown>;

interface Route {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
}

interface App {
  get(token: unknown): {
    register(provider: unknown): void;
    apply(task: string, args: unknown[]): Promise<Outcome>;
    delay(task: string, args: unknown[]): Promise<void>;
  };
  getHttpAdapter(): { getInstance(): Route };
  listen(port: number, host: string): Promise<unknown>;
}

const DIST = '../dist';

async function main(): Promise<void> {
  const { createApp } = (await import(`${DIST}/app.factory.js`)) as {
    createApp(): Promise<{ app: App; env: { PORT: number; DJANGO_TIME_ZONE: string } }>;
  };
  const { PaymentProviders } = (await import(`${DIST}/payments/providers.js`)) as {
    PaymentProviders: unknown;
  };
  const { app, env } = await createApp();
  app.get(PaymentProviders).register(await parityGateway());

  // The twin of `gateway/parity_gateway/jobs.py`: run one background job now,
  // every attempt its task allows, and say what it came to.
  const { JobWorker } = (await import(`${DIST}/jobs/job-worker.service.js`)) as {
    JobWorker: unknown;
  };
  app
    .getHttpAdapter()
    .getInstance()
    .post('/parity/jobs/run/', async (request, reply) => {
      const payload = JSON.parse(request.body?.bytes?.toString('utf8') || '{}') as {
        task: string;
        args?: unknown[];
      };
      return reply.send(await app.get(JobWorker).apply(payload.task, payload.args ?? []));
    });
  // Queue a job as any caller in the API does, through `Jobs`: for the worker
  // check (parity/worker-check.ts), which watches a worker take it up.
  const { Jobs } = (await import(`${DIST}/jobs/jobs.service.js`)) as { Jobs: unknown };
  app
    .getHttpAdapter()
    .getInstance()
    .post('/parity/jobs/queue/', async (request, reply) => {
      const payload = JSON.parse(request.body?.bytes?.toString('utf8') || '{}') as {
        task: string;
        args?: unknown[];
      };
      await app.get(Jobs).delay(payload.task, payload.args ?? []);
      return reply.send({ queued: payload.task });
    });
  // What is scheduled and what can be queued, as the Django stand-in reads
  // them off Celery: the two are compared as any other pair of answers.
  const { JOB_QUEUES, JOB_SCHEDULE, JOB_TIME_LIMIT_SECONDS } = (await import(
    `${DIST}/jobs/queues.js`
  )) as {
    JOB_QUEUES: Record<string, { retryLimit: number; retryDelay: number }>;
    JOB_SCHEDULE: { task: string; cron: string }[];
    JOB_TIME_LIMIT_SECONDS: number;
  };
  app
    .getHttpAdapter()
    .getInstance()
    .get('/parity/jobs/schedule/', async (_request, reply) =>
      reply.send({
        timezone: env.DJANGO_TIME_ZONE,
        time_limit: JOB_TIME_LIMIT_SECONDS,
        schedule: [...JOB_SCHEDULE].sort((a, b) => a.task.localeCompare(b.task)),
        tasks: Object.keys(JOB_QUEUES)
          .sort()
          .map((task) => ({
            task,
            retries: JOB_QUEUES[task]?.retryLimit,
            retry_delay: JOB_QUEUES[task]?.retryDelay,
          })),
      }),
    );
  await app.listen(env.PORT, '0.0.0.0');
}

void main();
