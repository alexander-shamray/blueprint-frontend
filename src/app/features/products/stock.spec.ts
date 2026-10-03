import { describe, expect, it } from 'vitest';
import { LOW_STOCK_THRESHOLD, stockLabel, stockOf } from './stock';

describe('stockOf', () => {
  it('reads null as never reported, and says nothing for it', () => {
    expect(stockOf(null)).toEqual({ kind: 'unreported' });
    expect(stockLabel(stockOf(null))).toBeNull();
  });

  it('reads zero and below as out of stock', () => {
    expect(stockOf(0)).toEqual({ kind: 'out' });
    expect(stockOf(-2)).toEqual({ kind: 'out' });
    expect(stockLabel(stockOf(0))).toBe('Out of stock');
  });

  it('says how many are left at and below the threshold', () => {
    expect(stockOf(LOW_STOCK_THRESHOLD)).toEqual({ kind: 'low', left: LOW_STOCK_THRESHOLD });
    expect(stockLabel(stockOf(1))).toBe('Only 1 left');
  });

  it('says in stock above the threshold', () => {
    expect(stockOf(LOW_STOCK_THRESHOLD + 1)).toEqual({ kind: 'in' });
    expect(stockLabel(stockOf(LOW_STOCK_THRESHOLD + 1))).toBe('In stock');
  });
});
