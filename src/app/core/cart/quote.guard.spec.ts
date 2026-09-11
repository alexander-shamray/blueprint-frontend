import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckoutHandoff } from './checkout-handoff';
import { quoteGuard } from './quote.guard';

describe('quoteGuard', () => {
  const run = () =>
    TestBed.runInInjectionContext(() => quoteGuard(null as never, null as never));

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('sends a checkout with no quote back to the cart', () => {
    const result = run();

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/tabs/cart');
  });

  it('lets a checkout with a quote through', () => {
    TestBed.inject(CheckoutHandoff).set({
      currency: 'GBP',
      lines: [{ productId: 'p1', name: 'Widget', amount: 10, quantity: 1, lineTotal: 10 }],
      total: 10, unpriced: [],
    });

    expect(run()).toBe(true);
  });
});
