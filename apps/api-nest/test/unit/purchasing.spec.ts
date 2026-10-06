import { supplierCodeBase } from '../../src/purchasing/suppliers.service';

/**
 * Buying's building blocks. Every expected value was printed by Django
 * itself, in the parity stack.
 */
describe('supplierCodeBase (unique_supplier_code, before it looks for a free one)', () => {
  it.each([
    ['Dhaka Textile House', 'DHAKA-TEXTILE-HOUSE'],
    ['  Rahman & Sons (Pvt.) Ltd.  ', 'RAHMAN-SONS-PVT-LTD'],
    ['The Parity Long Established Trading Company', 'THE-PARITY-LONG-ESTABLIS'],
    ['Parity Established Tradi ng Company', 'PARITY-ESTABLISHED-TRADI'],
    ['চা নাস্তা', 'SUPPLIER'],
    ['!!!', 'SUPPLIER'],
    ['', 'SUPPLIER'],
    ['a', 'A'],
    ['über Stoffe GmbH', 'BER-STOFFE-GMBH'],
    ['x'.repeat(40), 'X'.repeat(24)],
    ['--a--b--', 'A-B'],
    ['İstanbul Kumaş', 'STANBUL-KUMA'],
    ['ABC_def 123', 'ABC-DEF-123'],
    ['Ⅷ ¾ ٣', 'SUPPLIER'],
    ['A B\tC\nD', 'A-B-C-D'],
  ])('%j is %s', (name, code) => {
    expect(supplierCodeBase(name)).toBe(code);
  });
});
