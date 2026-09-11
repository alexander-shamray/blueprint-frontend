import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';
import { CartStore } from './cart.store';
import { CheckoutHandoff } from './checkout-handoff';
import { quoteGuard } from './quote.guard';

const product = (id: string): ProductSummary => ({
  productId: id, name: `Product ${id}`, thumbnailUrl: null,
  amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
});

describe('quoteGuard', () => {
  const run = () =>
    TestBed.runInInjectionContext(() => quoteGuard(null as never, null as never));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });
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

  it('refuses a quote whose basket was changed from another screen', () => {
    const store = TestBed.inject(CartStore);
    store.add(product('p1'));

    TestBed.inject(CheckoutHandoff).set({
      currency: 'GBP',
      lines: [{ productId: 'p1', name: 'Product p1', amount: 10, quantity: 1, lineTotal: 10 }],
      total: 10, unpriced: [],
    });
    expect(run()).toBe(true);

    // The money one, at the level it lives: this is ProductsPage.addToCart(),
    // which calls the store directly and touches nothing on the cart page.
    // Invalidation used to hang off CartPage's own steppers and currency
    // select, so after this line the guard still admitted /tabs/cart/checkout
    // and the customer was shown a total priced for a basket they no longer
    // had. (The platform reprices at order time, so they were not charged it
    // — but the one job of a quote is to say what someone will pay.)
    store.add(product('p2'));

    const result = run();
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/tabs/cart');
  });
});
