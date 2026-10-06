import { Injectable } from '@nestjs/common';

import { AuthService } from '../accounts/auth.service';
import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { itemCount, lineTotal, money, quantize } from '../checkout/pricing';
import { AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import {
  charField,
  decimalField,
  emailField,
  errorMessages,
  type Fields,
  integerField,
  Invalid,
  InvalidFields,
  nestedListField,
  runSerializer,
  uuidField,
  withDefault,
} from '../common/drf';
import { PermissionDenied, ValidationError } from '../common/errors';
import { Database } from '../database/database.service';
import {
  APPROVAL_MAX_AGE,
  type BasketInput,
  DISCOUNT_OVERRIDE,
  SalePricing,
  type SaleQuote,
} from './sale-pricing.service';

/** `PosSaleLineSerializer`. */
const LINE_FIELDS: Fields = {
  variant: uuidField(),
  quantity: integerField({ minValue: 1 }),
  line_discount: withDefault(decimalField(14, 2, { required: false, minValue: '0' }), () => '0.00'),
};

/** `PosBasketSerializer`: what a quote takes, and a sale with its payments. */
export const BASKET_FIELDS: Fields = {
  lines: nestedListField(LINE_FIELDS),
  customer: uuidField({ required: false, allowNull: true }),
  manual_discount: withDefault(
    decimalField(14, 2, { required: false, minValue: '0' }),
    () => '0.00',
  ),
  manual_discount_percent: decimalField(5, 2, {
    required: false,
    allowNull: true,
    minValue: '0',
    maxValue: '100',
  }),
  coupon_code: charField({ required: false, allowBlank: true, maxLength: 32 }),
  approval_token: charField({ required: false, allowBlank: true, maxLength: 512 }),
  branch: uuidField({ required: false, allowNull: true }),
};

export interface BasketData {
  lines: { variant: string; quantity: number | bigint; line_discount: string }[];
  customer?: string | null;
  manual_discount: string;
  manual_discount_percent?: string | null;
  coupon_code?: string;
  approval_token?: string;
  branch?: string | null;
  [key: string]: unknown;
}

/** `validate_lines` and `validate`, shared by the quote and the sale. */
export const BASKET_RULES = {
  hooks: {
    lines: (value: unknown[]) => {
      if (!value.length) throw Invalid.of('A sale needs at least one item.');
      return value;
    },
  },
  validate: <V extends BasketData>(attrs: V): V => {
    const percent = attrs.manual_discount_percent;
    if (percent !== null && percent !== undefined && !new Dec(attrs.manual_discount).isZero()) {
      throw new InvalidFields({
        manual_discount_percent: [
          {
            message: 'Give the discount as an amount or as a percentage, not both.',
            code: 'invalid',
          },
        ],
      });
    }
    return attrs;
  },
};

/** `_basket(data)`: the `SaleInput` fields a quote and a sale share. */
export function basketInput(data: BasketData): BasketInput {
  return {
    lines: data.lines.map((line) => ({
      variantId: line.variant,
      quantity: line.quantity,
      lineDiscount: quantize(line.line_discount),
    })),
    customerId: data.customer ?? null,
    manualDiscount: quantize(data.manual_discount),
    manualDiscountPercent: data.manual_discount_percent ?? null,
    couponCode: data.coupon_code ?? '',
    approvalToken: data.approval_token ?? '',
  };
}

/** `pos_quote_payload`: a priced basket for the register to show. Money is a string. */
export function quotePayload(quote: SaleQuote) {
  const priced = quote.priced;
  return {
    lines: priced.lines.map((line) => ({
      variant: line.variant.id,
      sku: line.variant.sku,
      quantity: line.quantity,
      unit_price: money(line.unitPrice),
      line_discount: money(line.lineDiscount),
      line_total: money(lineTotal(line)),
    })),
    subtotal: money(priced.subtotal),
    coupon: quote.coupon
      ? { code: quote.coupon.code, description: quote.coupon.description }
      : null,
    coupon_discount: money(priced.couponDiscount),
    manual_discount: money(priced.manualDiscount),
    discount_total: money(priced.discountTotal),
    tax_mode: priced.taxMode,
    tax_rate: quote.taxRateText,
    tax_total: money(priced.taxTotal),
    grand_total: money(priced.grandTotal),
    item_count: itemCount(priced),
    issues: quote.issues,
  };
}

interface ElevateData {
  email: string;
  password: string;
  permission: string;
  discount_percent?: string | null;
}

/**
 * The counter's two questions before a sale: what does this basket come to
 * (`PosQuoteView`), and will a manager let this through (`PosElevateView`).
 */
@Injectable()
export class PosCounterService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly pricing: SalePricing,
    private readonly auth: AuthService,
  ) {}

  /**
   * `PosQuoteView.post`: the basket priced exactly as the sale would record
   * it. Writes nothing. A coupon or a discount that cannot go through comes
   * back in `issues`, beside figures priced without it.
   */
  async quote(user: RequestUser, data: unknown) {
    const validated = await runSerializer<BasketData>(BASKET_FIELDS, data, BASKET_RULES);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const basket = validated.values;
    const branch = await this.permissions.resolveBranch(user, basket.branch ?? null);
    return quotePayload(await this.pricing.priceSale(branch, user, basketInput(basket), false));
  }

  /**
   * `PosElevateView.post`: a manager's own credentials, checked at the
   * counter. The cashier's session is never upgraded: the answer carries a
   * signed approval for this cashier, this permission and -- for a discount --
   * no more than the percentage the manager was shown. Both identities land
   * in the audit log.
   */
  async elevate(user: RequestUser, data: unknown, context: AuditContext) {
    const validated = await runSerializer<ElevateData & Record<string, unknown>>(
      {
        email: emailField(),
        password: charField({ trimWhitespace: false }),
        permission: charField({ maxLength: 64 }),
        discount_percent: decimalField(5, 2, {
          required: false,
          allowNull: true,
          minValue: '0',
          maxValue: '100',
        }),
      },
      data,
      {
        validate: (attrs) => {
          if (
            attrs.permission === DISCOUNT_OVERRIDE &&
            (attrs.discount_percent === null || attrs.discount_percent === undefined)
          ) {
            throw new InvalidFields({
              discount_percent: [
                { message: 'Say which discount the manager is approving.', code: 'invalid' },
              ],
            });
          }
          return attrs;
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const { email, password, permission } = validated.values;
    const percent = validated.values.discount_percent ?? null;

    const account = await this.auth.authenticate(email, password);
    const approver = account ? await this.pricing.staff(account.id) : null;
    if (!approver) throw new PermissionDenied('Those manager credentials were not accepted.');
    if (!(await this.permissions.has(approver, permission)))
      throw new PermissionDenied('That user cannot approve this action.');

    const newValues: Record<string, unknown> = { permission, approved_by: approver.email };
    if (percent !== null) newValues.discount_percent = money(quantize(percent));
    await recordAudit(this.db, context, {
      action: 'PERMISSION_ELEVATION',
      entity: { type: 'User', id: approver.id, label: approver.email },
      actor: { id: user.id, email: user.email },
      newValues,
      reason: 'POS manager override',
      // The counter it happened at is the cashier's (D95).
      branchId: user.branchId,
    });
    return {
      approved: true,
      approved_by: approver.fullName,
      approved_by_id: approver.id,
      permission,
      approval_token: this.pricing.approvalToken(approver, user, permission, percent),
      expires_in: APPROVAL_MAX_AGE,
    };
  }
}
