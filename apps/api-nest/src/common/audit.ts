/**
 * `core.audit.record`: one row in `core_auditlog` per important action.
 *
 * The request's address, user agent and id are what `core.middleware`'s
 * `AuditContextMiddleware` captures; here they are read off the request once,
 * in the controller, and passed down as plain values -- a service never sees
 * a request (CLAUDE.md section 4).
 *
 * Secrets are replaced before anything is written, by the same key list.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { clientIp } from '../auth/throttle';
import type { Env } from '../config/env';
import type { Queryable } from '../database/database.service';
import { pySlice } from './python';

export interface AuditContext {
  ipAddress: string | null;
  userAgent: string;
  requestId: string;
}

/** What `AuditContextMiddleware` stores for a request. */
export function auditContext(request: FastifyRequest, env: Env): AuditContext {
  const agent = request.headers['user-agent'];
  return {
    ipAddress: clientIp(request, env.DJANGO_TRUSTED_PROXY_HOPS) || null,
    userAgent: pySlice(Array.isArray(agent) ? agent.join(', ') : (agent ?? ''), 512),
    requestId: request.id ?? '',
  };
}

const REDACTED = '***';
const SENSITIVE_KEYS = new Set([
  'password',
  'password1',
  'password2',
  'new_password',
  'current_password',
  'token',
  'access',
  'refresh',
  'secret',
  'api_key',
  'authorization',
  'card_number',
  'cvv',
  'cvc',
  'pin',
  'signing_key',
]);

/** `_scrub`: secrets out, recursively. Values arrive already JSON-safe (strings for money and ids). */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : scrub(item),
      ]),
    );
  }
  return value;
}

export interface AuditEntity {
  /** `type(entity).__name__`: "User", "CustomerAddress". */
  type: string;
  id: string;
  /** `str(entity)`. */
  label: string;
}

export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditRecord {
  action: string;
  entity?: AuditEntity;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  actor?: AuditActor | null;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  reason?: string;
  branchId?: string | null;
}

/**
 * Write one audit entry, on `q` -- the pool, or the transaction the change
 * itself is in, so the entry and the change commit or vanish together.
 */
export async function recordAudit(
  q: Queryable,
  context: AuditContext,
  entry: AuditRecord,
): Promise<void> {
  let entityType = entry.entityType ?? '';
  let entityId = entry.entityId ?? '';
  let entityLabel = entry.entityLabel ?? '';
  if (entry.entity) {
    entityType = entityType || entry.entity.type;
    entityId = entityId || entry.entity.id;
    entityLabel = entityLabel || pySlice(entry.entity.label, 255);
  }
  const actor = entry.actor ?? null;
  // `clock_timestamp()`, not `now()`: Django stamps each row with the time it
  // was saved, and two entries in one transaction must not tie.
  await q.query(
    `INSERT INTO core_auditlog
       (id, created_at, updated_at, actor_id, actor_label, action, entity_type, entity_id,
        entity_label, old_values, new_values, reason, ip_address, user_agent, request_id, branch_id)
     VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, $5, $6, $7,
             $8::jsonb, $9::jsonb, $10, $11::inet, $12, $13, $14::uuid)`,
    [
      randomUUID(),
      actor?.id ?? null,
      pySlice(actor?.email ?? '', 255),
      entry.action,
      pySlice(entityType, 64),
      pySlice(entityId, 64),
      pySlice(entityLabel, 255),
      JSON.stringify(scrub(entry.oldValues ?? {})),
      JSON.stringify(scrub(entry.newValues ?? {})),
      entry.reason ?? '',
      context.ipAddress,
      context.userAgent,
      context.requestId,
      entry.branchId ?? null,
    ],
  );
}
