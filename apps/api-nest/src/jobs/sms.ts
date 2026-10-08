/**
 * `notifications.sms`, the part that is arithmetic and wording: how many
 * messages a gateway bills for, and the three order messages.
 *
 * A GSM-7 message holds 160 characters; one character outside that alphabet
 * -- a Bengali letter, a curly quote -- makes the whole message UCS-2, and
 * the limit 70. A joined message loses a little of each part to its header.
 */
import { pyStrip } from '../common/python';

const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** These cost two GSM-7 characters each. */
const GSM7_EXTENDED = new Set('^{}\\[~]|€');

const SINGLE_GSM7 = 160;
const MULTI_GSM7 = 153;
const SINGLE_UCS2 = 70;
const MULTI_UCS2 = 67;

/** `is_gsm7(body)`. Characters are Python's: code points. */
export function isGsm7(body: string): boolean {
  for (const character of body) {
    if (!GSM7.has(character) && !GSM7_EXTENDED.has(character)) return false;
  }
  return true;
}

/** `segments(body)`: how many messages the gateway will bill for. */
export function smsSegments(body: string): number {
  if (!body) return 0;
  const characters = Array.from(body);
  let length: number;
  let single: number;
  let multi: number;
  if (isGsm7(body)) {
    length = characters.reduce((sum, character) => sum + (GSM7_EXTENDED.has(character) ? 2 : 1), 0);
    [single, multi] = [SINGLE_GSM7, MULTI_GSM7];
  } else {
    length = characters.length;
    [single, multi] = [SINGLE_UCS2, MULTI_UCS2];
  }
  return length <= single ? 1 : Math.ceil(length / multi);
}

export interface SmsOrder {
  number: string;
  currency: string;
  grand_total: string;
  refunded_total: string;
}

/** `_tracking_url(order)`: the customer's link to an order, or nothing with no origin to put before it. */
export function trackingUrl(order: { number: string }, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return base ? `${base}/order/${order.number}` : '';
}

/**
 * `TEMPLATES`: each fits one segment. A type with no entry sends no SMS at
 * all, which is how "delivered" stays an email-only courtesy.
 */
const TEMPLATES: Readonly<Record<string, (order: SmsOrder, publicUrl: string) => string>> = {
  ORDER_CONFIRMED: (order, publicUrl) =>
    `Rangon: order ${order.number} confirmed, ${order.currency} ${order.grand_total}. ${trackingUrl(order, publicUrl)}`,
  ORDER_SHIPPED: (order, publicUrl) =>
    `Rangon: order ${order.number} is on its way. Please keep your phone nearby. ${trackingUrl(order, publicUrl)}`,
  REFUND_COMPLETED: (order) =>
    `Rangon: refund issued for order ${order.number}, ${order.currency} ${order.refunded_total}.`,
};

/** `body_for(order, notification_type)`. */
export function smsBodyFor(order: SmsOrder, notificationType: string, publicUrl: string): string {
  const template = Object.hasOwn(TEMPLATES, notificationType) ? TEMPLATES[notificationType] : null;
  return template ? pyStrip(template(order, publicUrl)) : '';
}
