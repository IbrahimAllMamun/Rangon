import { createApp } from './app.factory';

/**
 * The same application with no HTTP listener: a worker of its own, for a
 * deployment that keeps a slow mail server away from request latency
 * (ADR-0016). Start it with `RANGON_JOBS_BACKEND=pgboss`, and the API with
 * `RANGON_JOBS_WORKER=0`; by default the API process does this itself.
 */
async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();
  if (!env.jobsWorker) {
    throw new Error('The worker needs RANGON_JOBS_BACKEND=pgboss and RANGON_JOBS_WORKER on.');
  }
  await app.init();
}

void bootstrap();
