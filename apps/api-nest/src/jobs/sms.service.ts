import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { canonicalPhone } from '../common/phone';
import { pySlice, pyStrip } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { smsSegments } from './sms';

/** `SmsResult`: what happened, in terms the message log can store. */
export interface SmsResult {
  success: boolean;
  reference?: string;
  message?: string;
}

/** `ProviderNotConfigured`: a provider was selected but its credentials are absent. */
export class SmsProviderNotConfigured extends Error {}

export interface SmsProvider {
  code: string;
  /** `to` is the canonical `8801XXXXXXXXX`. A network fault is thrown, for the job to retry. */
  send(to: string, body: string): Promise<SmsResult>;
}

/**
 * `notifications.sms.send_sms` with `notifications.registry`: send one
 * message and record it in `notifications_smsmessage`, whatever happens --
 * sent, refused, or deliberately not sent (a number that is no mobile, or
 * one off the allowlist outside a live environment).
 *
 * The one provider there is, `console`, logs and sends nothing: a
 * deployment that has not named a gateway cannot text anybody.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger('rangon.sms');
  private readonly providers = new Map<string, SmsProvider>();

  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.register({
      code: 'console',
      send: (to, body) => {
        this.logger.log(`SMS to ${to}: ${body}`);
        return Promise.resolve({
          success: true,
          reference: `console-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        });
      },
    });
  }

  register(provider: SmsProvider): void {
    this.providers.set(provider.code, provider);
  }

  /** `_may_send_to(number)`: anybody in production; anywhere else, the allowlist. */
  private maySendTo(number: string): boolean {
    if (this.env.SMS_LIVE) return true;
    return this.env.SMS_ALLOWLIST.split(',')
      .map((entry) => pyStrip(entry))
      .filter(Boolean)
      .some((entry) => (canonicalPhone(entry) || entry) === number);
  }

  /** Returns the status the message was recorded with: `SENT`, `FAILED` or `SUPPRESSED`. */
  async send(message: {
    to: string | null;
    body: string;
    notificationType: string;
    orderNumber: string;
  }): Promise<string> {
    const number = canonicalPhone(message.to);
    // `get_provider()`: a code nobody registered is a `KeyError`, before anything is recorded.
    const provider = this.providers.get(this.env.SMS_PROVIDER);
    if (!provider) throw new Error(`SMS provider '${this.env.SMS_PROVIDER}' is not registered.`);

    const record = (fields: {
      status: string;
      error?: string;
      reference?: string;
      sent?: boolean;
    }) =>
      this.db.query(
        `INSERT INTO notifications_smsmessage
           (id, created_at, updated_at, "to", body, provider, status, reference, error, segments,
            notification_type, order_number, sent_at)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 ${fields.sent ? 'clock_timestamp()' : 'NULL'})`,
        [
          randomUUID(),
          number || pySlice(message.to ?? '', 32),
          message.body,
          provider.code,
          fields.status,
          pySlice(fields.reference ?? '', 128),
          fields.error ?? '',
          smsSegments(message.body),
          message.notificationType,
          message.orderNumber,
        ],
      );

    if (!number) {
      // A landline, a hotline, or a blank: recorded and skipped, not an error.
      await record({ status: 'SUPPRESSED', error: 'Not a Bangladeshi mobile number.' });
      return 'SUPPRESSED';
    }
    if (!this.maySendTo(number)) {
      await record({
        status: 'SUPPRESSED',
        error: 'Not on SMS_ALLOWLIST, and this is not a live environment.',
      });
      return 'SUPPRESSED';
    }
    let result: SmsResult;
    try {
      result = await provider.send(number, message.body);
    } catch (error) {
      if (!(error instanceof SmsProviderNotConfigured)) throw error;
      await record({ status: 'FAILED', error: `Provider not configured: ${error.message}` });
      this.logger.error(`SMS provider ${provider.code} is selected but not configured`);
      return 'FAILED';
    }
    await record({
      status: result.success ? 'SENT' : 'FAILED',
      reference: result.reference ?? '',
      error: result.success ? '' : pySlice(result.message ?? '', 2000),
      sent: result.success,
    });
    return result.success ? 'SENT' : 'FAILED';
  }
}
