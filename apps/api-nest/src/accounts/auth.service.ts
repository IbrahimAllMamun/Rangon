import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { passwordFingerprint, TokenError } from '../auth/jwt';
import { AuditContext, recordAudit } from '../common/audit';
import {
  bangladeshiPhoneField,
  charField,
  emailField,
  Errors,
  errorMessages,
  Invalid,
  InvalidFields,
  runSerializer,
} from '../common/drf';
import { invalidUuid, NotFound, ValidationError } from '../common/errors';
import { pyStr, pyStrip, pySlice } from '../common/python';
import { uuidFromValue } from '../common/uuid';
import { Database } from '../database/database.service';
import { dataGet, pyTruthy } from '../http/request-body';
import { ACCOUNT_COLUMNS, AccountRow, fullName, MeService } from './me.service';
import { makePassword, validatePassword, verifyPassword } from './passwords';
import { TokenPair, TokensService } from './tokens.service';

/** An answer the Django view writes by hand: no `request_id` in its envelope. */
export class ManualResponse {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {}
}

const LOGIN_REFUSED = new ManualResponse(401, {
  error: {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Incorrect email address or password.',
    details: {},
  },
});

const SESSION_EXPIRED = new ManualResponse(401, {
  error: {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'That session has expired. Please sign in again.',
    details: {},
  },
});

const REFRESH_REQUIRED = new ManualResponse(400, {
  error: {
    code: 'VALIDATION_ERROR',
    message: 'refresh is required.',
    details: { refresh: ['Required.'] },
  },
});

function entity(user: AccountRow) {
  return { type: 'User', id: user.id, label: user.email };
}

/**
 * `accounts/api/views.py`'s authentication views, with their serializers and
 * the `accounts.services` functions they call. Statement order follows the
 * Django code, because each statement commits on its own there (no
 * ATOMIC_REQUESTS) and a failure part-way leaves what it leaves.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TokensService,
    private readonly me: MeService,
  ) {}

  /**
   * `ModelBackend.authenticate`: the account by exact email, its password
   * checked -- and upgraded when the hash is out of date, whether or not the
   * account may sign in -- then `is_active`.
   */
  private async authenticate(email: string, password: string): Promise<AccountRow | null> {
    const user = await this.db.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts_user WHERE email = $1`,
      [email],
    );
    if (!user) {
      // Hash anyway, so a missing account answers as slowly as a wrong password.
      await makePassword(password);
      return null;
    }
    const { correct, mustUpdate } = await verifyPassword(password, user.password);
    if (correct && mustUpdate) await this.upgradeHash(user, password);
    return correct && user.is_active ? user : null;
  }

  /** `check_password`'s setter: save only the new hash. */
  private async upgradeHash(user: AccountRow, password: string): Promise<void> {
    user.password = await makePassword(password);
    await this.db.query(`UPDATE accounts_user SET password = $2 WHERE id = $1::uuid`, [
      user.id,
      user.password,
    ]);
  }

  /** `LoginView.post`. */
  async login(
    data: unknown,
    context: AuditContext,
  ): Promise<ManualResponse | Record<string, unknown>> {
    const validated = await runSerializer<{ email: string; password: string; user: AccountRow }>(
      { email: emailField(), password: charField({ trimWhitespace: false }) },
      data,
      {
        validate: async (attrs) => {
          const user = await this.authenticate(pyStrip(attrs.email.toLowerCase()), attrs.password);
          // Deliberately one message for a wrong email and a wrong password.
          if (!user)
            throw new InvalidFields({
              detail: [{ message: 'Incorrect email address or password.', code: 'invalid' }],
            });
          if (user.status !== 'ACTIVE') {
            throw new InvalidFields({
              detail: [{ message: 'This account is not active.', code: 'invalid' }],
            });
          }
          return { ...attrs, user };
        },
      },
    );
    if (!validated.ok) {
      const email = dataGet(data, 'email');
      await recordAudit(this.db, context, {
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityLabel: pySlice(email === undefined ? '' : pyStr(email), 255),
        reason: 'Invalid credentials',
      });
      return LOGIN_REFUSED;
    }

    const user = validated.values.user;
    const tokens = await this.tokens.issue(user);
    await this.db.query(
      `UPDATE accounts_user SET last_login = clock_timestamp(), last_login_ip = $2::inet WHERE id = $1::uuid`,
      [user.id, context.ipAddress],
    );
    await recordAudit(this.db, context, { action: 'LOGIN', entity: entity(user), actor: user });
    return { ...tokens, user: await this.me.payload(user) };
  }

  /**
   * `RefreshView.post`: rotate. The old refresh token is blacklisted and a
   * fresh pair minted, so both carry the current password claim.
   */
  async refresh(data: unknown): Promise<ManualResponse | TokenPair> {
    const token = dataGet(data, 'refresh');
    if (!pyTruthy(token)) return REFRESH_REQUIRED;
    try {
      const payload = await this.tokens.verifyRefresh(token);
      const user = await this.userFromClaims(payload);
      if (!user) return SESSION_EXPIRED;
      // A deactivated account, or a token issued under a password that has
      // since changed, is signed out. A token with no claim predates it and
      // is honoured (a password change blacklists it anyway).
      const claim = payload.hash_password;
      if (
        !user.is_active ||
        (claim !== undefined && claim !== null && claim !== passwordFingerprint(user.password))
      ) {
        return SESSION_EXPIRED;
      }
      if (!(await this.tokens.blacklist(token as string, payload))) return SESSION_EXPIRED;
      return await this.tokens.issue(user);
    } catch (error) {
      if (error instanceof TokenError) return SESSION_EXPIRED;
      throw error;
    }
  }

  /** `User.objects.get(pk=refresh["user_id"])`, or null for `DoesNotExist`. */
  private async userFromClaims(payload: Record<string, unknown>): Promise<AccountRow | null> {
    // A signed token without the claim is a KeyError in Django: a 500.
    if (!('user_id' in payload)) throw new Error("KeyError: 'user_id'");
    const lookup = uuidFromValue(payload.user_id);
    if ('invalid' in lookup) throw invalidUuid(pyStr(payload.user_id));
    if (!lookup.id) return null;
    return this.me.account(lookup.id);
  }

  /**
   * `LogoutView.post`: end the session the refresh token belongs to. Always
   * 204, and says nothing about whether the token was live.
   */
  async logout(data: unknown, context: AuditContext): Promise<void> {
    const token = dataGet(data, 'refresh');
    if (!pyTruthy(token)) return;
    let user: AccountRow | null;
    try {
      const payload = await this.tokens.verifyRefresh(token);
      user = await this.userFromClaims(payload);
      await this.tokens.blacklist(token as string, payload);
    } catch (error) {
      if (error instanceof TokenError) return;
      throw error;
    }
    if (user)
      await recordAudit(this.db, context, { action: 'LOGOUT', entity: entity(user), actor: user });
  }

  /** `MeView.get`. */
  async whoami(userId: string): Promise<Record<string, unknown>> {
    const user = await this.me.account(userId);
    if (!user) throw new NotFound();
    return this.me.payload(user);
  }

  /**
   * `RegisterView.post`: a CUSTOMER, never a client-chosen role, linked to the
   * customer record its phone already has or to a new one. One transaction.
   */
  async register(data: unknown): Promise<Record<string, unknown>> {
    const validated = await runSerializer<{
      email: string;
      password: string;
      first_name?: string;
      last_name?: string;
      phone?: string;
    }>(
      {
        email: emailField(),
        password: charField({ minLength: 10 }),
        first_name: charField({ required: false, allowBlank: true, maxLength: 80 }),
        last_name: charField({ required: false, allowBlank: true, maxLength: 80 }),
        phone: bangladeshiPhoneField({ required: false, allowBlank: true, maxLength: 32 }),
      },
      data,
      {
        hooks: {
          email: async (value: string) => {
            const taken = await this.db.one(
              `SELECT 1 AS found FROM accounts_user WHERE UPPER(email::text) = UPPER($1) LIMIT 1`,
              [pyStrip(value)],
            );
            if (taken) throw Invalid.of('An account with this email already exists.');
            return pyStrip(value.toLowerCase());
          },
          password: (value: string) => {
            const errors = validatePassword(value, null);
            if (errors.length) throw new Invalid(errors);
            return value;
          },
        },
      },
    );
    if (!validated.ok) throw this.invalid(validated.errors);
    const values = validated.values;

    const { user, tokens } = await this.db.transaction(async (tx) => {
      const role = await tx.one<{ id: string }>(
        `SELECT id FROM accounts_role WHERE code = 'CUSTOMER'`,
      );
      // `Role.objects.get(...)` raising DoesNotExist, which the handler answers with 404.
      if (!role) throw new NotFound();
      const organization = await tx.one<{ id: string }>(
        `SELECT id FROM accounts_organization WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1`,
      );
      const phone = values.phone ?? '';
      const created = await tx.one<AccountRow>(
        `INSERT INTO accounts_user
           (id, password, last_login, is_superuser, created_at, updated_at, email, first_name,
            last_name, phone, status, is_staff, is_active, date_joined, last_login_ip,
            branch_id, organization_id, role_id)
         VALUES ($1::uuid, $2, NULL, false, clock_timestamp(), clock_timestamp(), $3, $4, $5, $6,
                 'ACTIVE', false, true, clock_timestamp(), NULL, NULL, $7::uuid, $8::uuid)
         RETURNING ${ACCOUNT_COLUMNS}`,
        [
          randomUUID(),
          await makePassword(values.password),
          values.email,
          values.first_name ?? '',
          values.last_name ?? '',
          phone,
          organization?.id ?? null,
          role.id,
        ],
      );
      const account = created as AccountRow;

      // Already canonical: the serializer normalised it, so the match is
      // against the one spelling the table stores.
      const existing = phone
        ? await tx.one<{ id: string }>(
            `SELECT id FROM customers_customer WHERE phone = $1 ORDER BY name ASC LIMIT 1`,
            [phone],
          )
        : null;
      if (existing) {
        await tx.query(
          `UPDATE customers_customer SET user_id = $2::uuid, customer_type = 'REGISTERED',
                  updated_at = clock_timestamp() WHERE id = $1::uuid`,
          [existing.id, account.id],
        );
      } else {
        await tx.query(
          `INSERT INTO customers_customer
             (id, created_at, updated_at, name, phone, email, customer_type, is_walk_in, is_active,
              date_of_birth, notes, tags, total_orders, total_spent, loyalty_points, last_order_at,
              created_by_id, user_id)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, 'REGISTERED', false,
                   true, NULL, '', '[]'::jsonb, 0, 0, 0, NULL, NULL, $5::uuid)`,
          [randomUUID(), fullName(account), phone || null, account.email, account.id],
        );
      }
      return { user: account, tokens: await this.tokens.issue(account, tx) };
    });
    return { ...tokens, user: await this.me.payload(user) };
  }

  /**
   * `PasswordChangeView.post`: check the current password, change it, end
   * every session, and hand this one a fresh pair.
   */
  async changePassword(userId: string, data: unknown, context: AuditContext): Promise<TokenPair> {
    const user = await this.me.account(userId);
    if (!user) throw new NotFound();
    const validated = await runSerializer<{ current_password: string; new_password: string }>(
      { current_password: charField(), new_password: charField({ minLength: 10 }) },
      data,
      {
        hooks: {
          current_password: async (value: string) => {
            const { correct, mustUpdate } = await verifyPassword(value, user.password);
            if (correct && mustUpdate) await this.upgradeHash(user, value);
            if (!correct) throw Invalid.of('Your current password is incorrect.');
            return value;
          },
          new_password: (value: string) => {
            const errors = validatePassword(value, {
              firstName: user.first_name,
              lastName: user.last_name,
              email: user.email,
            });
            if (errors.length) throw new Invalid(errors);
            return value;
          },
        },
        // Someone changing a password because it may have leaked has fixed
        // nothing by choosing it again.
        validate: (attrs) => {
          if (attrs.new_password === attrs.current_password) {
            throw new InvalidFields({
              new_password: [
                { message: 'Choose a password you are not already using.', code: 'invalid' },
              ],
            });
          }
          return attrs;
        },
      },
    );
    if (!validated.ok) {
      // A wrong guess, not a blank field: only the check itself (and a value
      // that is not a string) carries the "invalid" code.
      const guesses = validated.errors.current_password;
      if (Array.isArray(guesses) && guesses.some((error) => error.code === 'invalid')) {
        await recordAudit(this.db, context, {
          action: 'LOGIN_FAILED',
          entity: entity(user),
          actor: user,
          reason: 'Wrong current password when changing the password',
        });
      }
      throw this.invalid(validated.errors);
    }

    const password = await makePassword(validated.values.new_password);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE accounts_user SET password = $2, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [user.id, password],
      );
      const ended = await this.tokens.endSessions(user.id, tx);
      await recordAudit(tx, context, {
        action: 'USER_CHANGED',
        entity: entity(user),
        actor: user,
        newValues: { password_changed: true, sessions_ended: ended },
        reason: 'Changed their own password; every other session signed out',
      });
    });
    return this.tokens.issue({ id: user.id, password });
  }

  private invalid(errors: Errors): ValidationError {
    return new ValidationError('Invalid input.', { details: errorMessages(errors) });
  }
}
