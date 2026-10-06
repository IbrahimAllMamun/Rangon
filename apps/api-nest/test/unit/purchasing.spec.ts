import { quantize } from '../../src/checkout/pricing';
import { averageAfterReturn } from '../../src/inventory/stock.service';
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

describe('averageAfterReturn (return_to_supplier: what is left is valued at what it cost)', () => {
  it.each([
    [10, '300.00', 2, '300.00', '300.00'],
    [4, '300.00', 2, '300.00', '300.00'],
    // Returned at more than the shelf is worth: clamped at nothing.
    [4, '10.00', 2, '300.00', '0.00'],
    [4, '333.33', 1, '300.00', '344.44'],
    // An emptied shelf keeps its last average.
    [3, '250.00', 3, '300.00', '250.00'],
    [7, '199.99', 3, '210.555', '192.06'],
    [9, '196.67', 5, '200.00', '192.51'],
    [3, '0.01', 1, '0.00', '0.02'],
    [1000000, '1234567.89', 999999, '1234567.88', '1244567.88'],
    [5, '100.00', 2, '33.335', '144.44'],
    [6, '0.00', 1, '5.00', '0.00'],
    [3, '100.005', 1, '100.00', '100.01'],
  ])('%i at %s, %i back at %s, leaves %s', (onHand, average, quantity, cost, left) => {
    expect(averageAfterReturn(onHand, average, quantity, quantize(cost))).toBe(left);
  });
});
