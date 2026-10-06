import {
  BLANK_PROFILE,
  changedProfileFields,
  type Profile,
} from '../../src/accounts/staff-users.service';
import { auditDiff } from '../../src/common/audit';

/**
 * Staff accounts. Every expected value was printed by Django itself
 * (`core.audit.diff`, and the change list `save_staff_profile` builds), in
 * the parity stack.
 */
describe('auditDiff (core.audit.diff)', () => {
  it.each([
    [
      { role: 'CASHIER', status: 'ACTIVE', email: 'a@x', branch: 'Main (M1)' },
      { role: 'MANAGER', status: 'ACTIVE', email: 'a@x', branch: null },
      [
        { role: 'CASHIER', branch: 'Main (M1)' },
        { role: 'MANAGER', branch: null },
      ],
    ],
    [
      { role: null, status: 'ACTIVE', email: 'a@x', branch: null },
      { role: null, status: 'ACTIVE', email: 'a@x', branch: null },
      [{}, {}],
    ],
    [
      { role: 'OWNER', status: 'ACTIVE', email: 'a@x', branch: null },
      { role: 'OWNER', status: 'SUSPENDED', email: 'b@x', branch: 'Main (M1)' },
      [
        { status: 'ACTIVE', email: 'a@x', branch: null },
        { status: 'SUSPENDED', email: 'b@x', branch: 'Main (M1)' },
      ],
    ],
    // A key only `after` has is read from `before` as null; one only `before` has is not looked at.
    [
      { status: 'ACTIVE' },
      { status: 'ACTIVE', email: 'new@x' },
      [{ email: null }, { email: 'new@x' }],
    ],
    [
      { status: 'ACTIVE', gone: 1 },
      { status: 'INACTIVE' },
      [{ status: 'ACTIVE' }, { status: 'INACTIVE' }],
    ],
  ])('%j to %j is %j', (before, after, diff) => {
    expect(auditDiff(before, after)).toEqual(diff);
  });
});

describe('changedProfileFields (save_staff_profile)', () => {
  const stored = (values: Partial<Profile>): Profile => ({ ...BLANK_PROFILE, ...values });

  it.each([
    // Blanks sent for a profile nobody has filled in change nothing: no row is made.
    [{}, { designation: '', joined_on: null, notes: '' }, []],
    [{}, { designation: 'Helper', blood_group: '', date_of_birth: null }, ['designation']],
    [
      { designation: 'Till clerk', joined_on: '2024-03-01', national_id: 'PARITY NID 1' },
      { designation: 'Till clerk', joined_on: '2024-03-01', national_id: 'PARITY NID 1' },
      [],
    ],
    [
      { designation: 'Till clerk', joined_on: '2024-03-01', national_id: 'PARITY NID 1' },
      { notes: 'x', joined_on: '2024-03-02', designation: 'Lead', national_id: 'PARITY NID 1' },
      ['designation', 'joined_on', 'notes'],
    ],
    [
      { national_id: 'A' },
      {
        national_id: '',
        emergency_contact_phone: '8801711000999',
        blood_group: 'O_POS',
        date_of_birth: null,
        joined_on: null,
      },
      ['blood_group', 'emergency_contact_phone', 'national_id'],
    ],
    [
      { joined_on: '2024-03-01', date_of_birth: '1990-01-01' },
      { joined_on: null, date_of_birth: null, present_address: '', permanent_address: 'P' },
      ['date_of_birth', 'joined_on', 'permanent_address'],
    ],
  ])('stored %j, sent %j: %j changed', (was, sent, changed) => {
    expect(changedProfileFields(stored(was), sent)).toEqual(changed);
  });
});
