import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditActor, AuditContext, recordAudit } from '../common/audit';
import {
  bangladeshiPhoneField,
  booleanField,
  charField,
  choiceField,
  Errors,
  errorMessages,
  Fields,
  runSerializer,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import { normalizePhone } from '../common/phone';
import { Database, Queryable } from '../database/database.service';

/**
 * `customers.services`: the only code that writes a customer's addresses,
 * because of one invariant -- at most one default address per customer. Each
 * write locks the customer row first, as `select_for_update()` does there, so
 * two concurrent "make this the default" requests cannot both find none.
 */

/** Written on every address mutation, so the audit trail shows the whole row. */
const ADDRESS_FIELDS = [
  'label',
  'address_type',
  'recipient_name',
  'phone',
  'line1',
  'line2',
  'area',
  'city',
  'district',
  'postal_code',
  'country',
  'is_default',
  'notes',
] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

const COLUMNS = ['id', 'created_at', 'updated_at', 'customer_id', ...ADDRESS_FIELDS] as const;
const SELECT = COLUMNS.map((column) => `"customers_customeraddress"."${column}"`).join(', ');

export interface AddressRow {
  id: string;
  customer_id: string;
  label: string;
  address_type: string;
  recipient_name: string;
  phone: string;
  line1: string;
  line2: string;
  area: string;
  city: string;
  district: string;
  postal_code: string;
  country: string;
  is_default: boolean;
  notes: string;
}

/** The model's defaults, for what a create leaves out. */
const DEFAULTS: Omit<AddressRow, 'id' | 'customer_id'> = {
  label: '',
  address_type: 'BOTH',
  recipient_name: '',
  phone: '',
  line1: '',
  line2: '',
  area: '',
  city: '',
  district: '',
  postal_code: '',
  country: 'Bangladesh',
  is_default: false,
  notes: '',
};

/** `CustomerAddressSerializer`'s writable fields, as ModelSerializer builds them. */
const FIELDS: Fields = {
  label: charField({ allowBlank: true, maxLength: 40, required: false }),
  address_type: choiceField(['SHIPPING', 'BILLING', 'BOTH'], { required: false }),
  recipient_name: charField({ maxLength: 160 }),
  phone: bangladeshiPhoneField({ maxLength: 32 }),
  line1: charField({ maxLength: 200 }),
  line2: charField({ allowBlank: true, maxLength: 200, required: false }),
  area: charField({ allowBlank: true, maxLength: 120, required: false }),
  city: charField({ maxLength: 120 }),
  district: charField({ allowBlank: true, maxLength: 120, required: false }),
  postal_code: charField({ allowBlank: true, maxLength: 20, required: false }),
  country: charField({ maxLength: 64, required: false }),
  is_default: booleanField({ required: false }),
  notes: charField({ allowBlank: true, maxLength: 255, required: false }),
};

type AddressData = Partial<Record<AddressField, string | boolean>>;

/** `CustomerAddressSerializer(address).data`. */
export function serialiseAddress(row: AddressRow): Record<string, unknown> {
  return {
    id: row.id,
    customer: row.customer_id,
    ...Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, row[field]])),
  };
}

/** `audit.snapshot(address, ADDRESS_FIELDS)`. */
function snapshot(row: AddressRow): Record<string, unknown> {
  return Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, row[field]]));
}

/** `str(address)`. */
function label(row: AddressRow): string {
  return `${row.recipient_name}, ${row.line1}, ${row.city}`;
}

function entity(row: AddressRow) {
  return { type: 'CustomerAddress', id: row.id, label: label(row) };
}

@Injectable()
export class AddressesService {
  constructor(private readonly db: Database) {}

  /** `customer.addresses.all()`: the default first, then the newest. */
  async list(customerId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<AddressRow>(
      `SELECT ${SELECT} FROM "customers_customeraddress"
        WHERE "customers_customeraddress"."customer_id" = $1::uuid
        ORDER BY "customers_customeraddress"."is_default" DESC, "customers_customeraddress"."created_at" DESC`,
      [customerId],
    );
    return rows.map(serialiseAddress);
  }

  /** `get_object_or_404(CustomerAddress, pk=id, customer=customer)`. */
  async find(id: string | null, customerId: string | null): Promise<AddressRow> {
    if (!id || !customerId) throw new NotFound();
    const row = await this.db.one<AddressRow>(
      `SELECT ${SELECT} FROM "customers_customeraddress"
        WHERE ("customers_customeraddress"."customer_id" = $1::uuid AND "customers_customeraddress"."id" = $2::uuid)
        LIMIT 21`,
      [customerId, id],
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** The serializer's validation, or DRF's 400 with its details. */
  async validate(data: unknown, partial: boolean): Promise<AddressData> {
    const result = await runSerializer<AddressData>(FIELDS, data, { partial });
    if (!result.ok) throw this.invalid(result.errors);
    return result.values;
  }

  private invalid(errors: Errors): ValidationError {
    return new ValidationError('Invalid input.', { details: errorMessages(errors) });
  }

  private async lock(tx: Queryable, customerId: string): Promise<void> {
    await tx.query(`SELECT id FROM customers_customer WHERE id = $1::uuid FOR UPDATE`, [
      customerId,
    ]);
  }

  /** Clear `is_default` on every other address of this customer (a bare UPDATE: no `updated_at`). */
  private async demoteOthers(tx: Queryable, customerId: string, keep: string): Promise<void> {
    await tx.query(
      `UPDATE customers_customeraddress SET is_default = false
        WHERE customer_id = $1::uuid AND is_default AND NOT (id = $2::uuid)`,
      [customerId, keep],
    );
  }

  /**
   * `add_address`: the customer's first address is its default whatever was
   * asked -- a customer with addresses but no default is one checkout cannot
   * pre-fill.
   */
  async add(
    customerId: string,
    data: AddressData,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<AddressRow> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, customerId);
      const wantsDefault = Boolean(data.is_default);
      const isFirst = !(await tx.one(
        `SELECT 1 AS found FROM customers_customeraddress WHERE customer_id = $1::uuid LIMIT 1`,
        [customerId],
      ));
      const values = { ...DEFAULTS, ...data, is_default: wantsDefault || isFirst } as AddressRow;
      // `CustomerAddress.save()` normalises the courier's number.
      values.phone = normalizePhone(values.phone) ?? '';
      const row = (await tx.one<AddressRow>(
        `INSERT INTO customers_customeraddress
           (id, created_at, updated_at, customer_id, ${ADDRESS_FIELDS.join(', ')})
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid,
                 ${ADDRESS_FIELDS.map((_, index) => `$${index + 3}`).join(', ')})
         RETURNING ${COLUMNS.join(', ')}`,
        [randomUUID(), customerId, ...ADDRESS_FIELDS.map((field) => values[field])],
      )) as AddressRow;
      if (row.is_default) await this.demoteOthers(tx, customerId, row.id);
      await recordAudit(tx, context, {
        action: 'CREATE',
        entity: entity(row),
        actor,
        newValues: snapshot(row),
        reason: 'Customer address added',
      });
      return row;
    });
  }

  /**
   * `update_address`: edit in place, holding the same invariant. Un-defaulting
   * the only address is refused; un-defaulting one with others on file leaves
   * it the default, as the Django service does.
   */
  async update(
    address: AddressRow,
    data: AddressData,
    actor: AuditActor,
    context: AuditContext,
  ): Promise<AddressRow> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, address.customer_id);
      const before = snapshot(address);
      const after = { ...address, ...data } as AddressRow;
      if (before.is_default && !after.is_default) {
        const others = await tx.one(
          `SELECT 1 AS found FROM customers_customeraddress
            WHERE customer_id = $1::uuid AND NOT (id = $2::uuid) LIMIT 1`,
          [address.customer_id, address.id],
        );
        if (!others) {
          throw new ValidationError(
            'This is the only address on file, so it stays the default. ' +
              'Add another address and make that one the default instead.',
          );
        }
        after.is_default = true;
      }
      after.phone = normalizePhone(after.phone) ?? '';
      // `address.save()`: every column written, `updated_at` restamped.
      const row = (await tx.one<AddressRow>(
        `UPDATE customers_customeraddress SET updated_at = clock_timestamp(),
                ${ADDRESS_FIELDS.map((field, index) => `${field} = $${index + 2}`).join(', ')}
          WHERE id = $1::uuid
          RETURNING ${COLUMNS.join(', ')}`,
        [address.id, ...ADDRESS_FIELDS.map((field) => after[field])],
      )) as AddressRow;
      if (row.is_default) await this.demoteOthers(tx, row.customer_id, row.id);

      // `audit.diff`: only the fields that changed.
      const now = snapshot(row);
      const changed = ADDRESS_FIELDS.filter((field) => before[field] !== now[field]);
      if (changed.length) {
        await recordAudit(tx, context, {
          action: 'UPDATE',
          entity: entity(row),
          actor,
          oldValues: Object.fromEntries(changed.map((field) => [field, before[field]])),
          newValues: Object.fromEntries(changed.map((field) => [field, now[field]])),
          reason: 'Customer address updated',
        });
      }
      return row;
    });
  }

  /**
   * `delete_address`: a real delete -- contact details, not a financial
   * record -- promoting a replacement default if this was it.
   */
  async remove(address: AddressRow, actor: AuditActor, context: AuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, address.customer_id);
      await recordAudit(tx, context, {
        action: 'DELETE',
        entity: entity(address),
        actor,
        oldValues: snapshot(address),
        reason: 'Customer address deleted',
      });
      await tx.query(`DELETE FROM customers_customeraddress WHERE id = $1::uuid`, [address.id]);
      if (!address.is_default) return;
      // `Meta.ordering` puts the newest first once no row claims default.
      const replacement = await tx.one<AddressRow>(
        `SELECT ${SELECT} FROM "customers_customeraddress"
          WHERE "customers_customeraddress"."customer_id" = $1::uuid
          ORDER BY "customers_customeraddress"."is_default" DESC, "customers_customeraddress"."created_at" DESC
          LIMIT 1`,
        [address.customer_id],
      );
      if (!replacement) return;
      await tx.query(
        `UPDATE customers_customeraddress SET updated_at = clock_timestamp(), is_default = true WHERE id = $1::uuid`,
        [replacement.id],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: entity({ ...replacement, is_default: true }),
        actor,
        oldValues: { is_default: false },
        newValues: { is_default: true },
        reason: `Promoted to default after address ${address.id} was deleted`,
      });
    });
  }
}
