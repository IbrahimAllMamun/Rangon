import { hostname } from 'node:os';

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  type BaseTransportOptions,
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  makeDsn,
  Scope,
  type Transport,
} from '@sentry/core';
import { nodeStackLineParser, ServerRuntimeClient } from '@sentry/core/server';
import type { FastifyRequest } from 'fastify';

import { acceptedHost, isSecure } from '../common/http';
import { ENV, Env } from '../config/env';

/** How long one report may take to leave, and how long shutdown waits for the last ones. */
const SEND_TIMEOUT_MS = 5000;
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Sends one envelope with `fetch`. `createTransport` is Sentry's own: it
 * queues, and it honours the rate limits a response carries, so a storm of
 * errors here does not become a storm of requests there.
 */
function makeTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      method: 'POST',
      body: request.body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return {
      statusCode: response.status,
      headers: {
        'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
        'retry-after': response.headers.get('retry-after'),
      },
    };
  });
}

/**
 * Errors nobody handled, reported to Sentry (ADR-0019) -- what
 * `config/settings/prod.py` sets `sentry_sdk` up to do for Django, with its
 * settings: on only under production settings with `SENTRY_DSN` set,
 * `send_default_pii=False`, `RANGON_ENV` and `RANGON_RELEASE`.
 *
 * Errors only: no tracing, and nothing is patched. The client is Sentry's
 * `@sentry/core`, given exactly three kinds of event by the code that
 * already logs them -- a request that ended in a 500 (or in a constraint the
 * service should have caught), a background job that failed for good, and
 * an exception that is about to end the process.
 *
 * What leaves with an event is chosen here, not gathered: the method, the
 * path and the route; the request id, which is also in the answer the client
 * got and in the log; the job's name. Never a body, a query string, a
 * cookie, a token or who was signed in.
 */
@Injectable()
export class ErrorReports implements OnModuleDestroy {
  private readonly logger = new Logger('rangon.errors');
  private readonly client: ServerRuntimeClient | null = null;
  private readonly onFatal = (error: unknown, origin: string) => this.fatal(error, origin);

  constructor(@Inject(ENV) private readonly env: Env) {
    const settings = env.sentry;
    if (!settings) return;
    // `sentry_sdk.init` raises `BadDsn`, and Django does not start.
    if (!makeDsn(settings.dsn)) throw new Error('SENTRY_DSN is not a Sentry DSN.');
    this.client = new ServerRuntimeClient({
      dsn: settings.dsn,
      environment: settings.environment,
      release: settings.release || undefined,
      sendDefaultPii: false,
      platform: 'node',
      runtime: { name: 'node', version: process.version },
      serverName: hostname(),
      stackParser: createStackParser(nodeStackLineParser()),
      // A cause is part of the error; the same error twice running is one.
      integrations: [linkedErrorsIntegration(), dedupeIntegration()],
      transport: makeTransport,
    });
    this.client.init();
    // The monitor sees an exception that is about to end the process, and
    // changes nothing about that: an `uncaughtException` listener would
    // keep the process alive in a state nobody chose.
    process.on('uncaughtExceptionMonitor', this.onFatal);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** A request answered 500, or 409 for a constraint that escaped the service layer. */
  request(error: unknown, request: FastifyRequest, status: number): void {
    const url = request.raw.url ?? request.url;
    const question = url.indexOf('?');
    const path = question === -1 ? url : url.slice(0, question);
    const route = request.routeOptions?.url ?? '';
    const host = acceptedHost(request, this.env);
    this.capture(error, (scope) => {
      scope.setTags({
        kind: 'request',
        status: String(status),
        request_id: String(request.id ?? ''),
        ...(route ? { route } : {}),
      });
      scope.setTransactionName(`${request.method} ${route || path}`);
      scope.addEventProcessor((event) => {
        event.request = {
          method: request.method,
          url: host ? `${isSecure(request, this.env) ? 'https' : 'http'}://${host}${path}` : path,
        };
        return event;
      });
    });
  }

  /** A background job that will not be tried again. `attempt` counts from one. */
  job(error: unknown, task: string, attempt: number): void {
    this.capture(error, (scope) => {
      scope.setTags({ kind: 'job', job: task, attempt: String(attempt) });
      scope.setTransactionName(task);
    });
  }

  private fatal(error: unknown, origin: string): void {
    this.capture(error, (scope) => {
      scope.setTags({ kind: 'process', origin });
      scope.setLevel('fatal');
    });
  }

  /** Reporting an error must never be a second one. */
  private capture(error: unknown, describe: (scope: Scope) => void): void {
    if (!this.client) return;
    try {
      const scope = new Scope();
      scope.setLevel('error');
      describe(scope);
      // The hint is how the integrations find the error's cause.
      this.client.captureException(error, { originalException: error }, scope);
    } catch (failure) {
      this.logger.warn(`Could not report an error to Sentry: ${String(failure)}`);
    }
  }

  /** What is still queued is given a moment to leave. */
  async onModuleDestroy(): Promise<void> {
    process.off('uncaughtExceptionMonitor', this.onFatal);
    try {
      await this.client?.close(FLUSH_TIMEOUT_MS);
    } catch {
      // Nothing to do about a report that could not leave.
    }
  }
}
