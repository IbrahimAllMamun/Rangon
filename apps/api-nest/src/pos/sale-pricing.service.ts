import { Inject, Injectable } from '@nestjs/common';

import { OrganizationService } from '../accounts/organization.service';
import type { RequestUser } from '../auth/authentication';
import { type BranchRow, canCrossBranch, RolePermissions } from '../auth/permissions';
import { CartService } from '../checkout/cart.service';
import {
  type CouponRow,
  CouponsService,
  pyContains,
  pyTruthyJson,
} from '../checkout/coupons.service';
import {
  calculate,
  lineGross,
  lineTotal,
  money,
  priceLines,
  type PricedLine,
  type PricedOrder,
  type PricedVariant,
  quantize,
  resolveTaxRateText,
  ZERO,
} from '../checkout/pricing';
import { Dec } from '../common/decimal';
import {
  BusinessError,
  CouponInvalid,
  invalidUuid,
  PermissionDenied,
  ValidationError,
} from '../common/errors';
import { pyDecimal, pyStr, pyStrip } from '../common/python';
import { BadSignature, SignatureExpired, signingDumps, signingLoads } from '../common/signing';
import { parseUuid, uuidFromValue } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { AvailabilityService } from '../inventory/availability.service';

/** What a manager holds that lets a discount pass the threshold. */
export const DISCOUNT_OVERRIDE = 'sales.discount_override';

/** A manager's approval travels from `pos/elevate/` to the sale signed with this salt. */
const APPROVAL_SALT = 'orders.pos.approval';
export const APPROVAL_MAX_AGE = 5 * 60;

const HUNDRED = new Dec(100);

export interface SaleLineInput {
  variantId: string;
  quantity: number | bigint;
  lineDiscount: Dec;
}

/** `SaleInput`, as far as pricing reads it. */
export interface BasketInput {
  lines: SaleLineInput[];
  customerId: string | null;
  manualDiscount: Dec;
  /** As DRF validated it: two places. Null when an amount was given instead. */
  manualDiscountPercent: string | null;
  couponCode: string;
  approvalToken: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  is_walk_in: boolean;
  total_orders: number;
  total_spent: string;
}

export interface StaffRow extends RequestUser {
  fullName: string;
}

/** Who let a discount above the threshold through, recorded on the sale. */
export interface DiscountOverride {
  approver: StaffRow | RequestUser;
  discount: Dec;
  percent: Dec;
  threshold: string;
}

export interface SaleIssue {
  code: string;
  field: string;
  message: string;
  details: unknown;
}

/** `SaleQuote`: a counter sale priced exactly as it would be recorded. */
export interface SaleQuote {
  priced: PricedOrder;
  /** The customer the cashier attached; null is an anonymous sale. */
  customer: CustomerRow | null;
  coupon: CouponRow | null;
  override: DiscountOverride | null;
  /** What stands between the basket and payment. Only a quote collects these. */
  issues: SaleIssue[];
  /** `str(priced.tax_rate)`: the rate as the database holds it, scale and all. */
  taxRateText: string;
}

interface VariantRow {
  id: string;
  sku: string;
  name: string;
  price: string;
  cost: string;
  product_id: string;
  product_name: string;
  category_id: string;
  category_tax_rate: string | null;
}

function times(count: number): string {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`;
}

/**
 * `orders.services.pos.price_sale` and what it calls: the register's running
 * total and the sale itself both come through here, so the figure a cashier
 * reads out is the figure the sale records.
 */
@Injectable()
export class SalePricing {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly organization: OrganizationService,
    private readonly availability: AvailabilityService,
    private readonly coupons: CouponsService,
    private readonly carts: CartService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `str(Decimal(settings.RANGON["DISCOUNT_APPROVAL_PERCENT"]))`. */
  private threshold(): string {
    const raw = this.env.RANGON_DISCOUNT_APPROVAL_PERCENT;
    return pyDecimal(raw) ?? raw;
  }

  /** A staff account as permissions read it, or null: `User.objects.filter(pk=..., is_active=True)`. */
  async staff(id: unknown, q: Queryable = this.db): Promise<StaffRow | null> {
    const uuid = parseUuid(typeof id === 'string' ? id : '');
    if (!uuid) return null;
    const row = await q.one<RequestUser>(
      `SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
              u.is_active AS "isActive", u.is_staff AS "isStaff", u.is_superuser AS "isSuperuser",
              u.status, u.role_id AS "roleId", r.code AS "roleCode", u.branch_id AS "branchId",
              u.organization_id AS "organizationId"
         FROM accounts_user u LEFT JOIN accounts_role r ON r.id = u.role_id
        WHERE u.id = $1::uuid AND u.is_active`,
      [uuid],
    );
    if (!row) return null;
    return { ...row, fullName: pyStrip(`${row.firstName} ${row.lastName}`) || row.email };
  }

  /** `user.full_name` of any account, active or not: the cashier named on a receipt. */
  async staffName(id: string): Promise<string> {
    const row = await this.db.one<{ first_name: string; last_name: string; email: string }>(
      `SELECT "first_name", "last_name", "email" FROM "accounts_user" WHERE "id" = $1`,
      [id],
    );
    return row ? pyStrip(`${row.first_name} ${row.last_name}`) || row.email : '';
  }

  /** `approval_token`: what a manager has just approved, for the register to carry to the sale. */
  approvalToken(
    approver: RequestUser,
    requestedBy: RequestUser,
    permission: string,
    maxPercent: string | null,
  ): string {
    return signingDumps(
      {
        approver: approver.id,
        cashier: requestedBy.id,
        permission,
        max_percent: maxPercent === null ? null : money(quantize(maxPercent)),
      },
      { key: this.env.DJANGO_SECRET_KEY, salt: APPROVAL_SALT },
    );
  }

  /**
   * `read_approval`: a manager's approval, checked at the moment a sale relies
   * on it. The approver is read again: one deactivated, moved off the role or
   * bound to another shop no longer approves.
   */
  private async readApproval(
    token: string,
    actor: RequestUser,
    branch: BranchRow,
    permission: string,
  ): Promise<{ approver: StaffRow; maxPercent: Dec | null }> {
    const refused = { details: { requires: permission } };
    let payload: Record<string, unknown>;
    try {
      payload = signingLoads(token, {
        key: this.env.DJANGO_SECRET_KEY,
        salt: APPROVAL_SALT,
        maxAge: APPROVAL_MAX_AGE,
      }) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SignatureExpired)
        throw new PermissionDenied(
          "The manager's approval has expired. Ask for it again.",
          refused,
        );
      if (error instanceof BadSignature)
        throw new PermissionDenied('That manager approval is not valid.', refused);
      throw error;
    }
    if (payload.cashier !== actor.id || payload.permission !== permission)
      throw new PermissionDenied('That approval was given for something else.', refused);

    // `User.objects.filter(pk=payload.get("approver"))`: a value that is not a
    // UUID is Django's own `ValidationError`, a 400 even on a quote.
    const lookup = uuidFromValue(payload.approver);
    if ('invalid' in lookup) throw invalidUuid(pyStr(payload.approver));
    const approver = lookup.id ? await this.staff(lookup.id) : null;
    if (!approver || !(await this.permissions.has(approver, permission)))
      throw new PermissionDenied(
        'The manager who approved this can no longer approve it.',
        refused,
      );
    if (!canCrossBranch(approver) && approver.branchId && approver.branchId !== branch.id)
      throw new PermissionDenied(
        'A manager can only approve a discount at their own branch.',
        refused,
      );
    const maxPercent = payload.max_percent;
    return {
      approver,
      maxPercent:
        maxPercent === null || maxPercent === undefined ? null : new Dec(String(maxPercent)),
    };
  }

  /**
   * `_check_discount_permission`: a large discount needs a manager. The
   * cashier's own discount -- lines plus the whole sale -- is measured
   * against the sale before any discount; a coupon's is not in it. Answers
   * who approved one above the threshold, or null when nothing needed
   * approving. Writes nothing.
   */
  private async checkDiscountPermission(
    actor: RequestUser,
    discount: Dec,
    subtotal: Dec,
    branch: BranchRow,
    approvalToken: string,
  ): Promise<DiscountOverride | null> {
    if (discount.lte(0)) return null;
    if (!(await this.permissions.has(actor, 'sales.discount')))
      throw new PermissionDenied('You do not have permission to apply discounts.');
    if (subtotal.lte(0)) return null;

    const exact = discount.div(subtotal).times(HUNDRED);
    const threshold = this.threshold();
    if (exact.lte(threshold)) return null;

    const percent = quantize(exact);
    const details = {
      discount: money(quantize(discount)),
      discount_percent: money(percent),
      threshold,
    };
    if (await this.permissions.has(actor, DISCOUNT_OVERRIDE))
      return { approver: actor, discount, percent, threshold };

    if (approvalToken) {
      const approval = await this.readApproval(approvalToken, actor, branch, DISCOUNT_OVERRIDE);
      if (approval.maxPercent !== null && percent.gt(approval.maxPercent)) {
        const approved = money(approval.maxPercent);
        throw new PermissionDenied(
          `The manager approved a discount of up to ${approved}%; this one is ${money(percent)}%.`,
          { details: { ...details, requires: DISCOUNT_OVERRIDE, approved_percent: approved } },
        );
      }
      return { approver: approval.approver, discount, percent, threshold };
    }
    throw new PermissionDenied(`A discount above ${threshold}% needs manager approval.`, {
      details: { ...details, requires: DISCOUNT_OVERRIDE },
    });
  }

  /** `_named_customer`: the customer the cashier attached; the walk-in record stands for nobody. */
  private async namedCustomer(customerId: string | null): Promise<CustomerRow | null> {
    if (!customerId) return null;
    const customer = await this.db.one<CustomerRow>(
      `SELECT "id", "name", "phone", "is_walk_in", "total_orders", "total_spent" FROM "customers_customer"
        WHERE "customers_customer"."id" = $1 ORDER BY "customers_customer"."name" ASC LIMIT 1`,
      [customerId],
    );
    return !customer || customer.is_walk_in ? null : customer;
  }

  /**
   * `_coupon_for_sale`: a code typed at the register. Everything checkout
   * checks, for the POS channel, and three refusals of the counter's own.
   */
  private async couponForSale(
    code: string,
    lines: PricedLine[],
    subtotal: Dec,
    customer: CustomerRow | null,
  ): Promise<[CouponRow, Dec]> {
    const coupon = await this.coupons.byCode(code);
    const details = { code: coupon.code };
    if (coupon.discount_type === 'FREE_SHIPPING') {
      throw new CouponInvalid(
        `${coupon.code} takes off the delivery charge, and a counter sale has none.`,
        { details },
      );
    }
    if (pyTruthyJson(coupon.channels) && !pyContains(coupon.channels, 'POS'))
      throw new CouponInvalid(`${coupon.code} cannot be used in store.`, { details });

    const result = await this.coupons.validate(
      coupon,
      lines,
      subtotal,
      customer?.id ?? null,
      'POS',
    );
    // The per-customer limit has to be counted against somebody.
    if (!customer && coupon.usage_limit_per_customer) {
      throw new CouponInvalid(
        `${coupon.code} can be used ${times(coupon.usage_limit_per_customer)} per ` +
          'customer, so it needs the customer on the sale. Attach them to apply it.',
        { details: { ...details, needs_customer: true } },
      );
    }
    return [coupon, result.discount];
  }

  /** `_manual_discount`: the cashier's discount on the whole sale, in money. */
  private manualDiscount(data: BasketInput, base: Dec): Dec {
    const amount = quantize(data.manualDiscount);
    const percent = data.manualDiscountPercent;
    if (percent === null) return amount;
    if (amount.gt(0)) {
      throw new ValidationError('Give the discount as an amount or as a percentage, not both.', {
        details: { manual_discount: money(amount), manual_discount_percent: percent },
      });
    }
    const value = new Dec(percent);
    if (value.lt(0) || value.gt(HUNDRED)) {
      throw new ValidationError('A percentage discount must be between 0 and 100.', {
        details: { manual_discount_percent: percent },
      });
    }
    return quantize(base.times(value).div(HUNDRED));
  }

  /** The variants of a basket, as pricing reads them; an id nothing has is refused. */
  private async variants(ids: string[]): Promise<Map<string, PricedVariant>> {
    const rows = ids.length
      ? await this.db.query<VariantRow>(
          `SELECT v."id", v."sku", v."name", v."price", v."cost", v."product_id",
                  p."name" AS "product_name", p."category_id", c."tax_rate" AS "category_tax_rate"
             FROM "catalog_productvariant" v
            INNER JOIN "catalog_product" p ON (v."product_id" = p."id")
            INNER JOIN "catalog_category" c ON (p."category_id" = c."id")
            WHERE v."id" = ANY($1::uuid[])`,
          [ids],
        )
      : [];
    const variants = new Map<string, PricedVariant>();
    for (const row of rows) {
      variants.set(row.id, {
        id: row.id,
        sku: row.sku,
        price: row.price,
        cost: row.cost,
        productId: row.product_id,
        productName: row.product_name,
        categoryId: row.category_id,
        categoryTaxRate: row.category_tax_rate,
        label: () => this.carts.variantLabel(row.id, row.name),
      });
    }
    const missing = ids.filter((id) => !variants.has(id));
    if (missing.length)
      throw new ValidationError('Unknown product variant.', { details: { variant_ids: missing } });
    return variants;
  }

  /**
   * `price_sale`. `strict` is the sale: the first refusal is thrown. A quote
   * collects coupon and discount refusals into `issues` and prices everything
   * else. A basket that cannot be priced at all is refused either way.
   */
  async priceSale(
    branch: BranchRow,
    actor: RequestUser,
    data: BasketInput,
    strict = true,
  ): Promise<SaleQuote> {
    if (!data.lines.length) throw new ValidationError('A sale needs at least one item.');
    const ids = data.lines.map((line) => line.variantId);
    const variants = await this.variants(ids);

    // Cost comes from the branch's weighted average at this moment (ADR-0006).
    const snapshots = await this.availability.availability(branch.id, [...variants.keys()]);
    const costs = new Map([...snapshots].map(([id, snapshot]) => [id, snapshot.averageCost]));
    const lines = priceLines(
      data.lines.map((line) => [
        variants.get(line.variantId) as PricedVariant,
        line.quantity,
        line.lineDiscount,
      ]),
      costs,
    );
    const subtotal = quantize(lines.reduce((sum, line) => sum.plus(lineTotal(line)), ZERO));
    const grossSubtotal = quantize(lines.reduce((sum, line) => sum.plus(lineGross(line)), ZERO));
    const lineDiscounts = quantize(lines.reduce((sum, line) => sum.plus(line.lineDiscount), ZERO));

    const customer = await this.namedCustomer(data.customerId);
    const issues: SaleIssue[] = [];
    const refuse = (error: BusinessError, field: string) => {
      if (strict) throw error;
      issues.push({ code: error.code, field, message: error.message, details: error.details });
    };

    let coupon: CouponRow | null = null;
    let couponDiscount = ZERO;
    const code = pyStrip(data.couponCode || '');
    if (code) {
      try {
        [coupon, couponDiscount] = await this.couponForSale(code, lines, subtotal, customer);
      } catch (error) {
        if (!(error instanceof CouponInvalid)) throw error;
        refuse(error, 'coupon');
      }
    }

    const manualDiscount = this.manualDiscount(data, quantize(subtotal.minus(couponDiscount)));

    let override: DiscountOverride | null = null;
    try {
      override = await this.checkDiscountPermission(
        actor,
        quantize(lineDiscounts.plus(manualDiscount)),
        grossSubtotal,
        branch,
        data.approvalToken,
      );
    } catch (error) {
      if (!(error instanceof PermissionDenied)) throw error;
      refuse(error, 'discount');
    }

    const organisation = await this.organization.taxSettings();
    const priced = calculate(lines, {
      couponDiscount,
      manualDiscount,
      couponId: coupon?.id ?? null,
      organisation,
    });
    const taxRateText = resolveTaxRateText(lines, organisation[1]);
    return { priced, customer, coupon, override, issues, taxRateText };
  }
}
