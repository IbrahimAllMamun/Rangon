import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { money, quantize, ZERO } from '../checkout/pricing';
import { Dec } from '../common/decimal';
import { InsufficientFunds, ValidationError } from '../common/errors';
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

/** `finance.models.TRANSACTION_SIGN`, for the movements a ported endpoint makes. */
const SIGN = { SALE_PAYMENT: 1, REFUND: -1 } as const;
export type MovementType = keyof typeof SIGN;

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

  /**
   * `record_movement` with no idempotency key: the account locked, refused
   * if closed or -- for money going out -- short, the balance moved and the
   * movement appended. A movement a sale causes is audited by the sale, not
   * here.
   */
  private async recordMovement(
    tx: Queryable,
    accountId: string,
    type: MovementType,
    posting: Posting,
  ): Promise<void> {
    const amount = quantize(posting.amount);
    if (amount.lte(ZERO)) throw new ValidationError('A movement amount must be positive.');
    const delta = quantize(amount.times(SIGN[type]));
    const locked = await tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a WHERE a.id IN ($1::uuid) ORDER BY a.id ASC FOR UPDATE`,
      [accountId],
    );
    if (!locked) throw new ValidationError(`No such account: ${accountId}.`);
    if (!locked.is_active) {
      throw new ValidationError(`${locked.name} is closed; money cannot move through it.`);
    }
    // `_check_can_reduce`: a drawer cannot pay out money it does not hold.
    if (delta.lt(ZERO) && new Dec(locked.balance).plus(delta).lt(ZERO) && !locked.allow_overdraft) {
      throw new InsufficientFunds(
        `${locked.name} holds ${formatMoney(locked.balance, this.env.RANGON_CURRENCY_SYMBOL)}, which is less than the ` +
          `${formatMoney(delta.abs(), this.env.RANGON_CURRENCY_SYMBOL)} this would take out.`,
        {
          details: {
            account_id: locked.id,
            account: locked.name,
            balance: locked.balance,
            requested: money(delta.abs()),
          },
        },
      );
    }
    const balance = quantize(new Dec(locked.balance).plus(delta));
    await tx.query('SAVEPOINT record_movement');
    await tx.query(
      `UPDATE finance_account SET updated_at = clock_timestamp(), balance = $2 WHERE id = $1::uuid`,
      [locked.id, money(balance)],
    );
    await tx.query(
      `INSERT INTO finance_accounttransaction
         (id, created_at, updated_at, account_id, transaction_type, amount, balance_after, reference_type,
          reference_id, reason, notes, occurred_at, created_by_id, idempotency_key)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $10, $3, $4, $5, $6, $11,
               $7, COALESCE($8::timestamptz, clock_timestamp()), $9::uuid, NULL)`,
      [
        randomUUID(),
        locked.id,
        money(delta),
        money(balance),
        posting.referenceType || 'manual',
        posting.referenceId,
        posting.notes,
        posting.occurredAt ?? null,
        posting.actorId ?? null,
        type,
        posting.reason ?? '',
      ],
    );
    await tx.query('RELEASE SAVEPOINT record_movement');
  }
}
