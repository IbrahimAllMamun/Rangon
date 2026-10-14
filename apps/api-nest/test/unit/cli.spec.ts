import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../../src/auth/permission-catalogue';
import { againstTheBaseline, MIGRATIONS, Refusal } from '../../src/cli/migrate';
import { parseFlags, text } from '../../src/cli/session';

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
    // And it hands the session back with the search path its header emptied,
    // or a migration after it on a new database finds no tables.
    expect(baseline.trimEnd()).toMatch(/set_config\('search_path', '"\$user", public', false\);$/);
  });

  it("carries none of drizzle-kit's identity limits rounded past bigint's range", () => {
    // `generate` writes `SET MAXVALUE 9223372036854776000` for every bigint
    // identity, a value PostgreSQL refuses: a later migration is hand-finished.
    for (const entry of journal.entries.slice(1)) {
      const sql = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8');
      expect(sql).not.toMatch(/MAXVALUE 9223372036854776000/);
    }
  });

  it('says which Django migrations the baseline stands for', () => {
    const head = JSON.parse(readFileSync(join(MIGRATIONS, 'django-head.json'), 'utf8')) as [
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

describe("a command's flags", () => {
  const known = ['branch', 'fix', 'reason'];

  it('reads a flag with a value and a flag alone', () => {
    expect(parseFlags(['--branch', 'DHK1', '--fix'], known)).toEqual({ branch: 'DHK1', fix: true });
  });

  it('keeps a value that has spaces in it', () => {
    expect(parseFlags(['--fix', '--reason', 'DR-2026 reconciliation'], known)).toEqual({
      fix: true,
      reason: 'DR-2026 reconciliation',
    });
  });

  it('refuses a flag the command does not take, and a word that is no flag', () => {
    expect(() => parseFlags(['--force'], known)).toThrow(Refusal);
    expect(() => parseFlags(['DHK1'], known)).toThrow(Refusal);
  });

  it('reads a flag given without a value as no text', () => {
    expect(text(parseFlags(['--reason'], known), 'reason')).toBe('');
    expect(text(parseFlags([], known), 'reason')).toBe('');
  });
});
