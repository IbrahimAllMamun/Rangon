import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../../src/auth/permission-catalogue';
import { againstTheBaseline, MIGRATIONS } from '../../src/cli/migrate';

describe('adopting a database Django built', () => {
  const head = [
    ['accounts', '0001_initial'],
    ['orders', '0008_payment_idempotency_key'],
  ] as const;

  it('finds nothing between the baseline and a database at the same migrations', () => {
    expect(againstTheBaseline(head, [...head].reverse())).toEqual({ missing: [], unknown: [] });
  });

  it('names what a database behind the baseline has not applied', () => {
    expect(againstTheBaseline(head, [head[0]])).toEqual({
      missing: ['orders.0008_payment_idempotency_key'],
      unknown: [],
    });
  });

  it('names what a database ahead of the baseline has that the baseline was not cut from', () => {
    expect(againstTheBaseline(head, [...head, ['orders', '0009_later']])).toEqual({
      missing: [],
      unknown: ['orders.0009_later'],
    });
  });
});

describe('the migrations the image carries', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };

  it('has a file for every entry of the journal, the baseline first', () => {
    expect(journal.entries[0]?.tag).toBe('0000_baseline');
    for (const entry of journal.entries)
      expect(existsSync(join(MIGRATIONS, `${entry.tag}.sql`))).toBe(true);
  });

  it('keeps the baseline as pg_dump wrote it, less what only psql can run', () => {
    const baseline = readFileSync(join(MIGRATIONS, '0000_baseline.sql'), 'utf8');
    expect(baseline).not.toMatch(/^\\/m);
    expect(baseline).not.toMatch(/^CREATE SCHEMA public;/m);
    expect(baseline).not.toMatch(/^COPY /m);
    // Django's foreign keys, as Django makes them.
    expect(baseline.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThan(100);
  });

  it('says which Django migrations the baseline stands for', () => {
    const head = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', 'django-head.json'), 'utf8')) as [
      string,
      string,
    ][];
    expect(head.length).toBeGreaterThan(50);
    expect(head.every(([app, name]) => Boolean(app) && Boolean(name))).toBe(true);
  });
});

describe('the permission catalogue', () => {
  const codes = Object.keys(PERMISSIONS);

  it('grants only codes it names', () => {
    for (const [role, held] of Object.entries(ROLE_PERMISSIONS)) {
      expect(held.filter((code) => !codes.includes(code))).toEqual([]);
      expect(new Set(held).size).toBe(held.length);
      expect(ROLES.map(([code]) => code)).toContain(role);
    }
  });

  it('gives an administrator every code, and a customer none', () => {
    expect(ROLE_PERMISSIONS.ADMIN).toEqual(codes);
    expect(ROLE_PERMISSIONS.CUSTOMER).toEqual([]);
  });

  it('leaves the owner out of the matrix: it holds every code implicitly', () => {
    expect(ROLE_PERMISSIONS.OWNER).toBeUndefined();
    expect(ROLES[0]).toEqual(['OWNER', 'Owner']);
  });

  it('files every code under the group its own prefix names', () => {
    for (const [code, [group]] of Object.entries(PERMISSIONS))
      expect(code.startsWith(`${group}.`)).toBe(true);
  });
});
