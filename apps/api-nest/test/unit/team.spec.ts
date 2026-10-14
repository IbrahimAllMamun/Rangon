import {
  BLANK_PROFILE,
  changedProfileFields,
  checkMayManageOwners,
  type Profile,
} from '../../src/accounts/staff-users.service';
import { auditDiff } from '../../src/common/audit';
import { PermissionDenied } from '../../src/common/errors';

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

/**
 * Only an owner manages an owner (business rule 7.1, `check_may_manage_owners`).
 * The cases are Django's own tests of it, `TestOnlyAnOwnerManagesOwners`.
 */
describe('checkMayManageOwners (check_may_manage_owners)', () => {
  const owner = { roleCode: 'OWNER', isSuperuser: false };
  const admin = { roleCode: 'ADMIN', isSuperuser: false };
  const superuser = { roleCode: 'CASHIER', isSuperuser: true };
  const anOwner = { role_code: 'OWNER', is_superuser: false };
  const aClerk = { role_code: 'CASHIER', is_superuser: false };
  const aSuperuser = { role_code: 'MANAGER', is_superuser: true };

  it.each([
    ['an owner, an owner', owner, anOwner, false],
    ['an owner, making an owner', owner, aClerk, true],
    ['an owner, creating an owner', owner, null, true],
    ['a superuser who is no owner, an owner', superuser, anOwner, false],
    ['a superuser who is no owner, making an owner', superuser, aClerk, true],
    ['an administrator, a clerk', admin, aClerk, false],
    ['an administrator, creating anyone else', admin, null, false],
    ['someone with no role, a clerk', { roleCode: null, isSuperuser: false }, aClerk, false],
  ] as const)('%s: allowed', (_name, actor, target, becomingOwner) => {
    expect(() => checkMayManageOwners(actor, target, becomingOwner)).not.toThrow();
  });

  it.each([
    ['an owner', anOwner, false, "Only an owner can change an owner's account.", 'user'],
    ['an owner, their role', anOwner, true, "Only an owner can change an owner's account.", 'user'],
    [
      "a superuser's account",
      aSuperuser,
      false,
      "Only an owner can change an owner's account.",
      'user',
    ],
    ['a clerk, made an owner', aClerk, true, 'Only an owner can give the owner role.', 'role_code'],
    [
      'nobody yet, created an owner',
      null,
      true,
      'Only an owner can give the owner role.',
      'role_code',
    ],
  ] as const)('an administrator, %s: refused', (_name, target, becomingOwner, message, key) => {
    let refusal: unknown;
    try {
      checkMayManageOwners(admin, target, becomingOwner);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PermissionDenied);
    expect((refusal as PermissionDenied).message).toBe(message);
    expect((refusal as PermissionDenied).statusCode).toBe(403);
    expect((refusal as PermissionDenied).details).toEqual({
      [key]: 'Ask an owner to make this change.',
    });
  });
});
