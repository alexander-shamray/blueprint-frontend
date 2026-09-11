import { describe, expect, it } from 'vitest';
import { CANCEL_REASONS, PERMISSIONS } from './types';

/**
 * These two vocabularies are the ones a screen renders directly, so a drift
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

  it('holds the three permissions the realm grants demo', () => {
    expect(Object.values(PERMISSIONS)).toEqual([
      'catalog:write',
      'orders:write',
      'orders:cancel',
    ]);
  });
});
