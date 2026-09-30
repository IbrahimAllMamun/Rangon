import { Injectable } from '@nestjs/common';

import { Dec } from '../common/decimal';

/**
 * `orders.payments`: the provider interface and its registry. No controller or
 * service holds provider-specific logic; a gateway is one class, registered
 * here. As in Django, the only provider this API ships is `manual`, which
 * takes no webhooks -- a gateway's signature check is ported with the gateway.
 */

/** `ProviderEvent`: a verified webhook, normalised. `eventId` must be stable, for replay detection. */
export interface ProviderEvent {
  eventId: string;
  eventType: string;
  orderNumber: string;
  reference: string;
  /** What the provider says it took; null when it cannot say. */
  amount: Dec | null;
  /** The event as the provider sent it, stored on the event and merged into the payment. */
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly code: string;
  readonly label: string;
  /** Verify the signature and parse, or throw `NoWebhooks` for a provider that receives none. */
  parseWebhook(body: Buffer, headers: Record<string, string>): ProviderEvent;
}

/** Python's `NotImplementedError` from `parse_webhook`: this provider sends no webhooks. */
export class NoWebhooks extends Error {}

/** `ManualProvider`: cash, card terminal, bank transfer, MFS typed by staff, COD. */
export class ManualProvider implements PaymentProvider {
  readonly code = 'manual';
  readonly label = 'Manual / in-person';

  parseWebhook(): ProviderEvent {
    throw new NoWebhooks('The manual provider does not receive webhooks.');
  }
}

/** `orders.payments.registry`: a provider by its code. */
@Injectable()
export class PaymentProviders {
  private readonly providers = new Map<string, PaymentProvider>([['manual', new ManualProvider()]]);

  register(provider: PaymentProvider): void {
    this.providers.set(provider.code, provider);
  }

  get(code: string): PaymentProvider | undefined {
    return this.providers.get(code);
  }
}
