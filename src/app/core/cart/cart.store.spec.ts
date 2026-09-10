import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';
import { CartStore } from './cart.store';

const product = (id: string, name = 'Thing', amount = 10): ProductSummary => ({
  productId: id,
  name,
  thumbnailUrl: null,
  amount,
  currency: 'EUR',
  publishedAt: '2026-09-10T00:00:00Z',
});

describe('CartStore', () => {
  let store: CartStore;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    write = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write } },
      ],
    });
    store = TestBed.inject(CartStore);
  });

  it('starts empty', () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('adds a product as a line of quantity one', () => {
    store.add(product('p1', 'Widget', 12.5));

    expect(store.lines()).toEqual([
      { productId: 'p1', name: 'Widget', amount: 12.5, currency: 'EUR', quantity: 1 },
    ]);
  });

  it('adding the same product again raises the quantity rather than duplicating the line', () => {
    store.add(product('p1'));
    store.add(product('p1'));

    expect(store.lines()).toHaveLength(1);
    expect(store.lines()[0].quantity).toBe(2);
    expect(store.count()).toBe(2);
  });

  it('setting a quantity of zero removes the line', () => {
    store.add(product('p1'));
    store.setQuantity('p1', 0);

    expect(store.lines()).toEqual([]);
  });

  it('refuses a negative quantity', () => {
    store.add(product('p1'));
    store.setQuantity('p1', -3);

    expect(store.lines()).toEqual([]);
  });

  it('persists on every change', () => {
    store.add(product('p1'));
    // Under zoneless change detection an effect() is scheduled, not run
    // synchronously on signal write — `await Promise.resolve()` alone does
    // not reliably flush it (it happens to pass on some runs only because the
    // scheduler's microtask beats the assertion by luck, which is exactly the
    // kind of flake this test must not have). TestBed.tick() synchronously
    // runs the pending effect, so the assertion follows a real flush rather
    // than a timing coincidence. There's no ComponentFixture here (CartStore
    // is injected directly, not rendered), so `fixture.whenStable()` is not
    // an option — TestBed.tick() is the fixture-free equivalent.
    TestBed.tick();

    expect(write).toHaveBeenCalledWith([
      { productId: 'p1', name: 'Thing', amount: 10, currency: 'EUR', quantity: 1 },
    ]);
  });

  it('restores what was persisted', async () => {
    const stored = [{ productId: 'p9', name: 'Restored', amount: 3, currency: 'GBP', quantity: 4 }];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => stored, write } },
      ],
    });

    const restored = TestBed.inject(CartStore);
    await restored.restore();

    expect(restored.lines()).toEqual(stored);
    expect(restored.count()).toBe(4);
  });

  it('restoring does not write back what it just read', async () => {
    const stored = [{ productId: 'p9', name: 'Restored', amount: 3, currency: 'GBP', quantity: 4 }];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => stored, write } },
      ],
    });

    const restored = TestBed.inject(CartStore);
    await restored.restore();
    TestBed.tick();

    expect(write).not.toHaveBeenCalled();
  });

  it('clear empties the cart and persists the emptiness', () => {
    store.add(product('p1'));
    store.clear();
    TestBed.tick();

    expect(store.lines()).toEqual([]);
    expect(write).toHaveBeenLastCalledWith([]);
  });
});
