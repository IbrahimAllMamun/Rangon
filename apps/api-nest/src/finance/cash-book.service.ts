import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { money, quantize, ZERO } from '../checkout/pricing';
import { type AuditActor, type AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import { InsufficientFunds, ValidationError } from '../common/errors';
import { compareCodePoints, pyStrip } from '../common/python';
import { nextNumber } from '../common/sequence';
import { ENV, Env } from '../config/env';
import { Queryable } from '../database/database.service';

/**
 * `core.money.format_money`: the currency symbol, then the amount to two
 * places (half up) with thousands separators -- what a refusal shown on a
 * money screen quotes.
 */
export function formatMoney(value: Dec | string, symbol: string): string {
  const amount = quantize(value);
  const [whole, cents] = money(amount.abs()).split('.') as [string, string];
  const sign = amount.isNeg() && !amount.isZero() ? '-' : '';
  return `${symbol} ${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** `finance.models.METHOD_TO_KIND`: the kind of account a method's money lands in. */
const METHOD_TO_KIND: Record<string, string> = {
  CASH: 'CASH',
  CARD: 'BANK',
  BANK: 'BANK',
  MOBILE_MFS: 'MFS',
  ONLINE_GATEWAY: 'BANK',
  COD: 'CASH',
  CHEQUE: 'BANK',
  STORE_CREDIT: 'OTHER',
  OTHER: 'OTHER',
};

/** `_METHOD_WORDS` and `_KIND_WORDS`: how `check_named_account` names things. */
const METHOD_WORDS: Record<string, string> = {
  CASH: 'Cash',
  COD: 'Cash-on-delivery',
  CARD: 'Card',
  BANK: 'Bank transfer',
  ONLINE_GATEWAY: 'Online gateway',
  CHEQUE: 'Cheque',
  MOBILE_MFS: 'bKash / Nagad',
  STORE_CREDIT: 'Store credit',
  OTHER: 'Other',
};
const KIND_WORDS: Record<string, string> = {
  CASH: 'cash',
  BANK: 'bank',
  MFS: 'mobile wallet',
  OTHER: 'other',
};

interface AccountRow {
  id: string;
  branch_id: string;
  name: string;
  kind: string;
  balance: string;
  is_active: boolean;
  allow_overdraft: boolean;
}

const ACCOUNT_COLUMNS =
  'a.id, a.branch_id, a.name, a.kind, a.balance, a.is_active, a.allow_overdraft';

/** A movement a business event causes, as `record_for_reference` takes it. */
export interface Posting {
  branch: { id: string; code: string };
  amount: Dec | string;
  referenceType: string;
  referenceId: string;
  /** The account the caller names, if any; otherwise the branch's own for the method. */
  accountId: string | null;
  method: string;
  notes: string;
  /** When the money moved; now, when the caller does not say. */
  occurredAt?: string | null;
  /** `created_by`: the member of staff who took the money, when one did. */
  actorId?: string | null;
  reason?: string;
}

/**
 * `finance.models.TRANSACTION_SIGN`: the sign put on the amount a caller
 * gives. ADJUSTMENT is 0 because its caller states the delta itself.
 */
const SIGN: Record<string, number> = {
  OPENING: 1,
  SALE_PAYMENT: 1,
  REFUND: -1,
  SUPPLIER_PAYMENT: -1,
  EXPENSE: -1,
  TRANSFER_IN: 1,
  TRANSFER_OUT: -1,
  DEPOSIT: 1,
  WITHDRAWAL: -1,
  ADJUSTMENT: 0,
};
export type MovementType = 'SALE_PAYMENT' | 'REFUND' | 'SUPPLIER_PAYMENT' | 'EXPENSE';
/** `REASON_REQUIRED`: an unexplained movement of money is a red flag. */
const REASON_REQUIRED = new Set(['ADJUSTMENT', 'WITHDRAWAL']);

/** One movement, as `record_movement` takes it. */
export interface Movement {
  accountId: string;
  type: string;
  /** Absolute for every type but ADJUSTMENT, which carries its own sign. */
  amount: Dec | string;
  actor?: AuditActor | null;
  referenceType?: string;
  referenceId?: string | null;
  reason?: string;
  notes?: string;
  /** When the money moved, as PostgreSQL should read it; now, when not given. */
  occurredAt?: string | null;
  idempotencyKey?: string | null;
}

/** Python's `f"{value:+}"` of a quantized Decimal: always signed. */
export function signedMoney(value: Dec): string {
  const text = money(value);
  return text.startsWith('-') ? text : `+${text}`;
}

/**
 * The part of `finance.services` a captured payment reaches: find the account
 * the money landed in, and append the movement to its cash book under the
 * account's row lock: `SALE_PAYMENT` in, `REFUND` out.
 */
@Injectable()
export class CashBookService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** `METHOD_TO_KIND.get(str(method).upper())`: the kind of account a method's money moves through. */
  kindOf(method: string): string | undefined {
    return METHOD_TO_KIND[method.toUpperCase()];
  }

  /**
   * `_already_posted`: has this event already moved a balance? Asked of the
   * cash book itself, since that is what must not be counted twice.
   */
  async alreadyPosted(tx: Queryable, referenceType: string, referenceId: string): Promise<boolean> {
    const row = await tx.one(
      `SELECT 1 AS a FROM finance_accounttransaction WHERE (reference_id = $1 AND reference_type = $2) LIMIT 1`,
      [referenceId, referenceType],
    );
    return row !== null;
  }

  /**
   * `record_for_reference(transaction_type=SALE_PAYMENT, ...)`. Answers the
   * account posted to, or null when the branch has none able to hold this
   * method's money -- the sale still stands, and `verify_accounts` reports
   * the gap.
   */
  async recordSalePayment(tx: Queryable, posting: Posting): Promise<string | null> {
    return this.recordForReference(tx, 'SALE_PAYMENT', posting);
  }

  /**
   * `record_for_reference(transaction_type=REFUND, ...)`: the money back out
   * of the account that holds it -- refused when a drawer does not hold that
   * much and may not go overdrawn.
   */
  async recordRefund(tx: Queryable, posting: Posting): Promise<string | null> {
    return this.recordForReference(tx, 'REFUND', posting);
  }

  /**
   * `record_for_reference(transaction_type=SUPPLIER_PAYMENT, ...)`: money out
   * to a supplier, from the account named or the branch's own for the method.
   */
  async recordSupplierPayment(tx: Queryable, posting: Posting): Promise<string | null> {
    return this.recordForReference(tx, 'SUPPLIER_PAYMENT', posting);
  }

  private async recordForReference(
    tx: Queryable,
    type: MovementType,
    posting: Posting,
  ): Promise<string | null> {
    let named: AccountRow | null = null;
    if (posting.accountId) {
      named = await tx.one<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a WHERE a.id = $1::uuid`,
        [posting.accountId],
      );
      if (named) this.checkNamedAccount(named, posting.branch, posting.method);
    }
    const resolved = named ?? (await this.resolveAccount(tx, posting.branch.id, posting.method));
    if (!resolved) return null;
    await this.recordMovement(tx, resolved.id, type, posting);
    return resolved.id;
  }

  /**
   * `check_named_account`: an account the caller names must be this branch's,
   * open, and of the kind the method's money moves through (D95).
   */
  private checkNamedAccount(
    account: AccountRow,
    branch: { id: string; code: string },
    method: string,
  ): void {
    if (account.branch_id !== branch.id) {
      throw new ValidationError('That account belongs to another branch.', {
        details: { account: [`Choose one of ${branch.code}'s accounts.`] },
      });
    }
    if (!account.is_active) {
      throw new ValidationError('That account is closed.', {
        details: { account: ['That account is closed.'] },
      });
    }
    if (!method) return;
    const kind = METHOD_TO_KIND[method.toUpperCase()];
    if (kind === undefined) {
      throw new ValidationError(`${method} is not a payment method.`, {
        details: { method: ['Unknown method.'] },
      });
    }
    if (account.kind !== kind) {
      const wanted = `${kind === 'OTHER' ? 'an' : 'a'} ${KIND_WORDS[kind]} account`;
      throw new ValidationError(
        `${METHOD_WORDS[method.toUpperCase()] ?? method} money moves through ${wanted}, not ${account.name}.`,
        { details: { account: [`Choose ${wanted}.`] } },
      );
    }
  }

  /**
   * `resolve_account`: the branch's default open account of the method's kind,
   * else its first by name -- or none, rather than a guess. Django's
   * statements: the first orders by the model's ordering, which joins the branch.
   */
  private async resolveAccount(
    tx: Queryable,
    branchId: string,
    method: string,
  ): Promise<AccountRow | null> {
    const kind = METHOD_TO_KIND[method.toUpperCase()];
    if (kind === undefined) return null;
    const preferred = await tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a
         INNER JOIN accounts_branch b ON (a.branch_id = b.id)
        WHERE (a.branch_id = $1::uuid AND a.is_active AND a.kind = $2 AND a.is_default)
        ORDER BY b.name ASC, a.kind ASC, a.name ASC LIMIT 1`,
      [branchId, kind],
    );
    if (preferred) return preferred;
    return tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a
        WHERE (a.branch_id = $1::uuid AND a.is_active AND a.kind = $2) ORDER BY a.name ASC LIMIT 1`,
      [branchId, kind],
    );
  }

  /** The movement a retry of this key already posted, if any. */
  private async movementByKey(tx: Queryable, key: string): Promise<string | null> {
    const row = await tx.one<{ id: string }>(
      `SELECT "id" FROM "finance_accounttransaction"
        WHERE "finance_accounttransaction"."idempotency_key" = $1
        ORDER BY "finance_accounttransaction"."occurred_at" DESC,
                 "finance_accounttransaction"."created_at" DESC LIMIT 1`,
      [key],
    );
    return row?.id ?? null;
  }

  /** `_lock_accounts`: the rows locked, lowest id first, so two transfers cannot deadlock. */
  private async lockAccounts(
    tx: Queryable,
    ids: readonly string[],
  ): Promise<Map<string, AccountRow>> {
    const unique = [...new Set(ids)];
    const marks = unique.map((_, index) => `$${index + 1}::uuid`).join(', ');
    const rows = await tx.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a WHERE a.id IN (${marks})
        ORDER BY a.id ASC FOR UPDATE`,
      unique,
    );
    const found = new Map(rows.map((row) => [row.id, row]));
    const missing = unique.filter((id) => !found.has(id)).sort(compareCodePoints);
    if (missing.length) throw new ValidationError(`No such account: ${missing.join(', ')}.`);
    return found;
  }

  /** `_check_can_reduce`: an account cannot pay out money it does not hold, overdraft aside. */
  private checkCanReduce(account: AccountRow, delta: Dec): void {
    if (delta.gte(ZERO)) return;
    if (new Dec(account.balance).plus(delta).lt(ZERO) && !account.allow_overdraft) {
      const symbol = this.env.RANGON_CURRENCY_SYMBOL;
      throw new InsufficientFunds(
        `${account.name} holds ${formatMoney(account.balance, symbol)}, which is less than the ` +
          `${formatMoney(delta.abs(), symbol)} this would take out.`,
        {
          details: {
            account_id: account.id,
            account: account.name,
            balance: account.balance,
            requested: money(delta.abs()),
          },
        },
      );
    }
  }

  /** `_apply`: the locked row's balance moved and the matching ledger entry appended. */
  private async apply(
    tx: Queryable,
    account: AccountRow,
    type: string,
    delta: Dec,
    entry: {
      actorId: string | null;
      referenceType: string;
      referenceId: string | null;
      reason: string;
      notes: string;
      occurredAt: string | null;
      idempotencyKey: string | null;
    },
  ): Promise<string> {
    const balance = quantize(new Dec(account.balance).plus(delta));
    await tx.query(
      `UPDATE finance_account SET updated_at = clock_timestamp(), balance = $2 WHERE id = $1::uuid`,
      [account.id, money(balance)],
    );
    account.balance = money(balance);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO finance_accounttransaction
         (id, created_at, updated_at, account_id, transaction_type, amount, balance_after, reference_type,
          reference_id, reason, notes, occurred_at, created_by_id, idempotency_key)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::timestamptz, clock_timestamp()), $11::uuid, $12)`,
      [
        id,
        account.id,
        type,
        money(delta),
        money(balance),
        entry.referenceType || 'manual',
        entry.referenceId || '',
        entry.reason,
        entry.notes,
        entry.occurredAt,
        entry.actorId,
        entry.idempotencyKey || null,
      ],
    );
    return id;
  }

  /**
   * `record_movement`: one movement appended to an account's cash book,
   * under the account's row lock. Once per `idempotencyKey`: the key is
   * looked for before the lock, again under it -- before the checks, so a
   * replayed withdrawal is not refused for money it already took (D89) --
   * and a retry that loses the race for the key answers with the winner's
   * movement (D90). A movement a person chose to make is audited here; one a
   * sale or a payment caused is audited by what caused it.
   */
  async move(tx: Queryable, movement: Movement, context?: AuditContext): Promise<string> {
    const key = movement.idempotencyKey || null;
    if (key) {
      const existing = await this.movementByKey(tx, key);
      if (existing) return existing;
    }
    const sign = SIGN[movement.type];
    if (sign === undefined)
      throw new ValidationError(`${movement.type} is not a valid account transaction type.`);
    const amount = quantize(movement.amount);
    let delta: Dec;
    if (sign === 0) {
      delta = amount;
      if (delta.isZero()) throw new ValidationError('An adjustment of zero changes nothing.');
    } else {
      if (amount.lte(ZERO)) throw new ValidationError('A movement amount must be positive.');
      delta = quantize(amount.times(sign));
    }
    const reason = movement.reason ?? '';
    if (REASON_REQUIRED.has(movement.type) && !pyStrip(reason))
      throw new ValidationError(`A ${movement.type} needs a reason.`);

    const locked = (await this.lockAccounts(tx, [movement.accountId])).get(
      movement.accountId,
    ) as AccountRow;
    if (key) {
      const existing = await this.movementByKey(tx, key);
      if (existing) return existing;
    }
    if (!locked.is_active)
      throw new ValidationError(`${locked.name} is closed; money cannot move through it.`);
    this.checkCanReduce(locked, delta);

    const referenceType = movement.referenceType ?? '';
    let id: string;
    await tx.query('SAVEPOINT record_movement');
    try {
      id = await this.apply(tx, locked, movement.type, delta, {
        actorId: movement.actor?.id ?? null,
        referenceType,
        referenceId: movement.referenceId ?? null,
        reason,
        notes: movement.notes ?? '',
        occurredAt: movement.occurredAt ?? null,
        idempotencyKey: key,
      });
      await tx.query('RELEASE SAVEPOINT record_movement');
    } catch (error) {
      if (!String((error as { code?: string }).code).startsWith('23')) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT record_movement');
      const winner = key === null ? null : await this.movementByKey(tx, key);
      if (winner) return winner;
      throw error;
    }

    if (referenceType === '' || referenceType === 'manual' || referenceType === 'account') {
      if (!context) throw new Error('A manual movement is audited: pass the audit context.');
      await recordAudit(tx, context, {
        action: 'PAYMENT_RECORDED',
        entity: {
          type: 'AccountTransaction',
          id,
          label: `${locked.name} ${signedMoney(delta)}`,
        },
        actor: movement.actor ?? null,
        newValues: {
          account: locked.name,
          type: movement.type,
          amount: money(delta),
          balance_after: locked.balance,
        },
        reason,
        branchId: locked.branch_id,
      });
    }
    return id;
  }

  /** A movement a sale, a refund or a payment causes: `record_movement` with no key. */
  private async recordMovement(
    tx: Queryable,
    accountId: string,
    type: MovementType,
    posting: Posting,
  ): Promise<void> {
    await this.move(tx, {
      accountId,
      type,
      amount: posting.amount,
      actor: posting.actorId ? { id: posting.actorId, email: '' } : null,
      referenceType: posting.referenceType || 'manual',
      referenceId: posting.referenceId,
      reason: posting.reason ?? '',
      notes: posting.notes,
      occurredAt: posting.occurredAt ?? null,
    });
  }

  /** The transfer a retry of this key already made, if any. */
  private async transferByKey(tx: Queryable, key: string): Promise<string | null> {
    const row = await tx.one<{ id: string }>(
      `SELECT "id" FROM "finance_accounttransfer"
        WHERE "finance_accounttransfer"."idempotency_key" = $1
        ORDER BY "finance_accounttransfer"."occurred_at" DESC LIMIT 1`,
      [key],
    );
    return row?.id ?? null;
  }

  /**
   * `transfer`: money moved between two of the business's own accounts --
   * TRANSFER_OUT and TRANSFER_IN in one transaction, both rows locked lowest
   * id first. The transfer's own row is written before either movement, so a
   * retry claims its key, or loses it, before any money moves.
   */
  async transfer(
    tx: Queryable,
    context: AuditContext,
    asked: {
      sourceId: string;
      targetId: string;
      amount: Dec | string;
      actor: AuditActor | null;
      notes: string;
      occurredAt: string | null;
      idempotencyKey: string | null;
    },
  ): Promise<string> {
    const key = asked.idempotencyKey || null;
    if (key) {
      const existing = await this.transferByKey(tx, key);
      if (existing) return existing;
    }
    if (asked.sourceId === asked.targetId)
      throw new ValidationError('Source and destination accounts must differ.');
    const amount = quantize(asked.amount);
    if (amount.lte(ZERO)) throw new ValidationError('A transfer amount must be positive.');

    const locked = await this.lockAccounts(tx, [asked.sourceId, asked.targetId]);
    const source = locked.get(asked.sourceId) as AccountRow;
    const target = locked.get(asked.targetId) as AccountRow;
    if (key) {
      const existing = await this.transferByKey(tx, key);
      if (existing) return existing;
    }
    for (const account of [source, target]) {
      if (!account.is_active)
        throw new ValidationError(`${account.name} is closed; money cannot move through it.`);
    }
    this.checkCanReduce(source, amount.neg());

    const when =
      asked.occurredAt ??
      ((await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as { now: string }).now;
    const id = randomUUID();
    await tx.query('SAVEPOINT account_transfer');
    try {
      const number = await nextNumber(tx, 'account_transfer', 'ATR');
      await tx.query(
        `INSERT INTO finance_accounttransfer
           (id, created_at, updated_at, number, source_account_id, target_account_id, amount,
            occurred_at, notes, created_by_id, idempotency_key)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, $4::uuid, $5,
                 $6::timestamptz, $7, $8::uuid, $9)`,
        [
          id,
          number,
          source.id,
          target.id,
          money(amount),
          when,
          asked.notes,
          asked.actor?.id ?? null,
          key,
        ],
      );
      await tx.query('RELEASE SAVEPOINT account_transfer');
    } catch (error) {
      if (!String((error as { code?: string }).code).startsWith('23')) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT account_transfer');
      const winner = key === null ? null : await this.transferByKey(tx, key);
      if (winner) return winner;
      throw error;
    }

    const entry = {
      actorId: asked.actor?.id ?? null,
      referenceType: 'account_transfer',
      referenceId: id,
      reason: '',
      notes: asked.notes,
      occurredAt: when,
      idempotencyKey: null,
    };
    await this.apply(tx, source, 'TRANSFER_OUT', amount.neg(), entry);
    await this.apply(tx, target, 'TRANSFER_IN', amount, entry);

    const number = (
      (await tx.one<{ number: string }>(
        `SELECT "number" FROM "finance_accounttransfer" WHERE "id" = $1`,
        [id],
      )) as { number: string }
    ).number;
    await recordAudit(tx, context, {
      action: 'PAYMENT_RECORDED',
      entity: { type: 'AccountTransfer', id, label: `${number}: ${money(amount)}` },
      actor: asked.actor,
      newValues: { from: source.name, to: target.name, amount: money(amount) },
      reason: asked.notes,
      branchId: source.branch_id,
    });
    return id;
  }
}
