import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { money, quantize, ZERO } from '../checkout/pricing';
import { Dec } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { Queryable } from '../database/database.service';

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
}

const ACCOUNT_COLUMNS = 'a.id, a.branch_id, a.name, a.kind, a.balance, a.is_active';

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
  occurredAt: string;
}

/**
 * The part of `finance.services` a captured payment reaches: find the account
 * the money landed in, and append the movement to its cash book under the
 * account's row lock. Only `SALE_PAYMENT` so far -- the one movement a ported
 * endpoint makes.
 */
@Injectable()
export class CashBookService {
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
    await this.recordMovement(tx, resolved.id, posting);
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
   * `record_movement` for a credit with no idempotency key: the account locked,
   * refused if closed, the balance moved and the movement appended. A movement
   * a sale causes is audited by the sale, not here.
   */
  private async recordMovement(tx: Queryable, accountId: string, posting: Posting): Promise<void> {
    const amount = quantize(posting.amount);
    if (amount.lte(ZERO)) throw new ValidationError('A movement amount must be positive.');
    const delta = quantize(amount);
    const locked = await tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM finance_account a WHERE a.id IN ($1::uuid) ORDER BY a.id ASC FOR UPDATE`,
      [accountId],
    );
    if (!locked) throw new ValidationError(`No such account: ${accountId}.`);
    if (!locked.is_active) {
      throw new ValidationError(`${locked.name} is closed; money cannot move through it.`);
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
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, 'SALE_PAYMENT', $3, $4, $5, $6, '',
               $7, $8::timestamptz, NULL, NULL)`,
      [
        randomUUID(),
        locked.id,
        money(delta),
        money(balance),
        posting.referenceType || 'manual',
        posting.referenceId,
        posting.notes,
        posting.occurredAt,
      ],
    );
    await tx.query('RELEASE SAVEPOINT record_movement');
  }
}
