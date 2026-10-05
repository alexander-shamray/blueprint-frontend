import { describe, expect, it } from 'vitest';
import { BUYER_STATUSES, CANCEL_REASONS, PERMISSIONS, TERMINAL_STATUSES } from './types';

/**
 * These vocabularies are the ones a screen renders directly, so a drift
 * from the backend shows up as a wrong dropdown or a hidden button rather than
 * as a type error. The e2e smoke exercises them against the real realm; this
 * catches a typo without Docker.
 */
describe('backend vocabularies', () => {
  it('holds the five cancellation reasons in Commands.cs order', () => {
    expect(CANCEL_REASONS).toEqual([
      'out_of_stock',
      'stock_timeout',
      'payment_declined',
      'payment_timeout',
      'customer_request',
    ]);
  });

  it('holds the seven buyer statuses in BuyerStatuses.cs, in BuyerStatus.Of rank order', () => {
    expect(BUYER_STATUSES).toEqual([
      'placed',
      'confirmed',
      'dispatched',
      'cancelled',
      'out_of_stock',
      'declined',
      'delivered',
    ]);
  });

  it('treats delivered and the three cancellation members as terminal, and nothing else', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['cancelled', 'declined', 'delivered', 'out_of_stock'],
    );
  });

  it('holds the three permissions the realm grants demo', () => {
    expect(Object.values(PERMISSIONS)).toEqual([
      'catalog:write',
      'orders:write',
      'orders:cancel',
    ]);
  });
});
