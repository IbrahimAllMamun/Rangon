import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { SkipAuthentication } from '../auth/authentication';
import { auditContext } from '../common/audit';
import { NotFound, strParam } from '../common/errors';
import { ENV, Env } from '../config/env';
import { RawBody } from '../http/request-body';
import { PaymentsService } from '../payments/payments.service';
import { NoWebhooks, PaymentProviders, ProviderEvent } from '../payments/providers';

/** `dict(request.headers)`: every header, each a single string. */
function headersOf(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(',') : (value ?? ''),
    ]),
  );
}

/**
 * `PaymentWebhookView` (`orders/api/shop_views.py`). No authentication and no
 * permission check: a webhook is trusted by its signature, which only the
 * provider can check. The body is handed over as bytes, never parsed here.
 * Throttled as any anonymous request is.
 */
@Controller('api/v1/shop/payments')
@SkipAuthentication()
export class ShopPaymentsController {
  constructor(
    private readonly providers: PaymentProviders,
    private readonly payments: PaymentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post(':provider/webhook/')
  @HttpCode(200)
  async webhook(@Param('provider') rawProvider: string, @Req() request: FastifyRequest) {
    const provider = strParam(rawProvider);
    const gateway = this.providers.get(provider);
    if (!gateway) throw new NotFound(`Unknown payment provider '${provider}'.`);
    let event: ProviderEvent;
    try {
      const body = request.body instanceof RawBody ? request.body.bytes : Buffer.alloc(0);
      event = gateway.parseWebhook(body, headersOf(request));
    } catch (error) {
      if (error instanceof NoWebhooks) throw new NotFound('This provider does not send webhooks.');
      throw error;
    }
    const result = await this.payments.handleWebhook(
      provider,
      event,
      auditContext(request, this.env),
    );
    return { received: true, result };
  }
}
