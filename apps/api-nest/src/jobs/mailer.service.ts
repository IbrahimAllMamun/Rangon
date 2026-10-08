import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { ENV, Env } from '../config/env';

/**
 * `django.core.mail.send_mail(..., fail_silently=False)` over SMTP, with
 * Django's settings (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`,
 * `EMAIL_PASSWORD`, `EMAIL_USE_TLS`, `EMAIL_TIMEOUT`, `DEFAULT_FROM_EMAIL`):
 * plain text, one message per call, and a failure raised for the job to retry.
 *
 * Without `EMAIL_USE_TLS` the connection is never upgraded, as Django's
 * backend never offers STARTTLS it was not told to use.
 */
@Injectable()
export class Mailer {
  private transport: Transporter | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  private smtp(): Transporter {
    const timeout = this.env.EMAIL_TIMEOUT * 1000;
    this.transport ??= createTransport({
      host: this.env.EMAIL_HOST,
      port: this.env.EMAIL_PORT,
      secure: false,
      requireTLS: this.env.EMAIL_USE_TLS,
      ignoreTLS: !this.env.EMAIL_USE_TLS,
      ...(this.env.EMAIL_USER
        ? { auth: { user: this.env.EMAIL_USER, pass: this.env.EMAIL_PASSWORD } }
        : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
    return this.transport;
  }

  async send(message: { subject: string; text: string; to: string[] }): Promise<void> {
    await this.smtp().sendMail({
      from: this.env.DEFAULT_FROM_EMAIL,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
