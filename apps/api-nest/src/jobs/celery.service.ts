import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { pyReprStr } from '../common/python';
import { ENV, Env } from '../config/env';

/**
 * Hands work to the Django API's Celery worker by writing Celery's own task
 * message into the broker, exactly as `task.delay(...)` does from Python --
 * so an order placed through this API sends its email and SMS through the
 * same worker, templates and provider as one placed through Django
 * (ADR-0014; the choice was the owner's, 2026-09-30).
 *
 * Celery 5.4, message protocol 2, over kombu's Redis transport: the envelope
 * below, JSON, pushed onto the queue's list (`celery`). Only the default
 * queue and positional string arguments are needed -- every task the ported
 * endpoints queue takes ids and a notification type.
 *
 * Like Django's `transaction.on_commit`, callers enqueue only after their
 * transaction commits: a rolled-back sale must send nothing.
 */
/**
 * A Celery 5 task message, protocol 2, as kombu writes it to Redis: the
 * envelope, with the body -- `[args, kwargs, embed]` -- as base64 JSON.
 */
export function celeryMessage(
  task: string,
  args: string[],
  meta: { id: string; origin: string; replyTo: string; deliveryTag: string },
): Record<string, unknown> {
  const body = JSON.stringify([
    args,
    {},
    { callbacks: null, errbacks: null, chain: null, chord: null },
  ]);
  // Python's repr of the args tuple: a lone element keeps its trailing comma.
  const argsrepr = `(${args.map(pyReprStr).join(', ')}${args.length === 1 ? ',' : ''})`;
  return {
    body: Buffer.from(body, 'utf8').toString('base64'),
    'content-encoding': 'utf-8',
    'content-type': 'application/json',
    headers: {
      lang: 'py',
      task,
      id: meta.id,
      shadow: null,
      eta: null,
      expires: null,
      group: null,
      group_index: null,
      retries: 0,
      timelimit: [null, null],
      root_id: meta.id,
      parent_id: null,
      argsrepr,
      kwargsrepr: '{}',
      origin: meta.origin,
      ignore_result: false,
      replaced_task_nesting: 0,
      stamped_headers: null,
      stamps: {},
    },
    properties: {
      correlation_id: meta.id,
      reply_to: meta.replyTo,
      delivery_mode: 2,
      delivery_info: { exchange: '', routing_key: 'celery' },
      priority: 0,
      body_encoding: 'base64',
      delivery_tag: meta.deliveryTag,
    },
  };
}

@Injectable()
export class CeleryService implements OnModuleDestroy {
  private readonly logger = new Logger('rangon.jobs');
  private client: Redis | null = null;
  private readonly origin = `gen${process.pid}@${hostname()}`;
  // Celery sets one reply queue per producer process.
  private readonly replyTo = randomUUID();

  constructor(@Inject(ENV) private readonly env: Env) {}

  private broker(): Redis {
    this.client ??= new Redis(this.env.CELERY_BROKER_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
    return this.client;
  }

  /**
   * `task.delay(*args)`, best effort: a failure is logged, never raised. The
   * caller's transaction has committed by now, so raising would answer 500
   * for an order that was placed -- which is what Django does (D116).
   */
  async delay(task: string, args: string[]): Promise<void> {
    const message = celeryMessage(task, args, {
      id: randomUUID(),
      origin: this.origin,
      replyTo: this.replyTo,
      deliveryTag: randomUUID(),
    });
    try {
      const redis = this.broker();
      // kombu's binding of the default queue (routing key, pattern, queue).
      await redis.sadd('_kombu.binding.celery', 'celery\x06\x16\x06\x16celery');
      await redis.lpush('celery', JSON.stringify(message));
    } catch (error) {
      this.logger.error(`Could not queue ${task}: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }
}
