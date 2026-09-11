import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProductSummary, QuoteResponse } from '@core/api/types';
import { CartPersistence } from './cart.persistence';
import { CartStore } from './cart.store';
import { CheckoutHandoff } from './checkout-handoff';

const product = (id: string): ProductSummary => ({
  productId: id, name: `Product ${id}`, thumbnailUrl: null,
  amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
});

const quote: QuoteResponse = {
  currency: 'EUR',
  lines: [{ productId: 'p1', name: 'Product p1', amount: 10, quantity: 1, lineTotal: 10 }],
  total: 10,
  unpriced: [],
};

describe('CheckoutHandoff', () => {
  let handoff: CheckoutHandoff;
  let store: CartStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });

    store = TestBed.inject(CartStore);
    handoff = TestBed.inject(CheckoutHandoff);
    store.add(product('p1'));
  });

  it('hands back the quote it was given', () => {
    handoff.set(quote);

    expect(handoff.quote()).toBe(quote);
  });

  it('does not invalidate a quote the moment it is set', () => {
    // The trap in a version check: stamp the quote with the version it will
    // be compared against a beat later, and it can read as stale on the very
    // tick it was recorded. `set()` records the version in force NOW, which
    // is by definition the basket the quote was priced for.
    store.add(product('p2'));
    handoff.set(quote);

    expect(handoff.quote()).toBe(quote);
  });

  it('reports no quote once the basket has been mutated from anywhere', () => {
    handoff.set(quote);

    // Not through CartPage, and that is the whole point: this is the call
    // ProductsPage.addToCart() makes. Invalidation is tied to the mutation,
    // so a screen that knows nothing about quotes still invalidates one.
    store.add(product('p2'));

    expect(handoff.quote()).toBeNull();
  });

  it('reports no quote after the basket is emptied', () => {
    handoff.set(quote);

    store.clear();

    expect(handoff.quote()).toBeNull();
  });

  it('leaves a quote alone when a mutator changed nothing', () => {
    handoff.set(quote);

    // setQuantity for a product the cart does not hold is a no-op — the
    // basket the quote was priced for is unchanged, so the quote is not.
    store.setQuantity('not-in-the-cart', 4);

    expect(handoff.quote()).toBe(quote);
  });

  it('clear() still works on its own, for the currency change the store cannot see', () => {
    handoff.set(quote);

    handoff.clear();

    expect(handoff.quote()).toBeNull();
  });
});
