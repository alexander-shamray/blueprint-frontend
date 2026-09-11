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

  describe('version', () => {
    // The counter CheckoutHandoff and CartPage compare a quote against. It is
    // the store's job precisely because the screens that mutate the basket —
    // the cart page's steppers, the products page's Add button — are not the
    // screen that holds the quote.
    it('moves on every mutation that changes the basket', () => {
      const versions = [store.version()];

      store.add(product('p1'));
      versions.push(store.version());
      store.add(product('p1'));
      versions.push(store.version());
      store.setQuantity('p1', 5);
      versions.push(store.version());
      store.remove('p1');
      versions.push(store.version());
      store.add(product('p2'));
      versions.push(store.version());
      store.clear();
      versions.push(store.version());

      // Strictly increasing: every entry greater than the one before it. The
      // assertion is "it moved", not "it moved by one" — callers compare, they
      // do not count.
      expect(versions.every((v, i) => i === 0 || v > versions[i - 1])).toBe(true);
    });

    it('moves when a restore replaces the basket wholesale', async () => {
      // Belt and braces rather than load-bearing — app.config.ts blocks
      // bootstrap on restore(), so no quote can exist yet — but the version
      // means "the lines changed", and a restore changes them.
      const before = store.version();

      await store.restore();

      expect(store.version()).toBeGreaterThan(before);
    });

    it('does not move when a mutator changed nothing', () => {
      store.add(product('p1'));
      const before = store.version();

      // A quantity for a product the cart no longer holds — plausible from a
      // UI holding a stale reference. Nothing changed, so no quote priced for
      // this basket has gone stale.
      store.setQuantity('p2', 3);

      expect(store.version()).toBe(before);
    });
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

  it('setQuantity for a productId not in the cart is a no-op and does not persist', () => {
    // .map() allocates a new array even when nothing matches, so without an
    // early return this no-op call would still trigger the persistence
    // effect and write unchanged content — wasteful, not data-lossy, but
    // pointless work on every call from a stale UI reference.
    store.add(product('p1'));
    TestBed.tick();
    write.mockClear();

    store.setQuantity('missing', 5);
    TestBed.tick();

    expect(store.lines()).toEqual([
      { productId: 'p1', name: 'Thing', amount: 10, currency: 'EUR', quantity: 1 },
    ]);
    expect(write).not.toHaveBeenCalled();
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

  it('a genuine change made after restore but before the effect flushes still persists', async () => {
    // This is the case the reference-identity guard exists for: restore()
    // sets `pendingRestore` to the array it just read, but a real mutation
    // made before that array is ever observed by the (deferred) effect must
    // still be written — the guard must suppress only the restore's own
    // echo, not everything that happens to be pending when it flushes.
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
    // Deliberately no TestBed.tick() here: the restore's own write-back must
    // still be pending (unflushed) when the genuine mutation below happens.
    restored.setQuantity('p9', 7);
    TestBed.tick();

    expect(write).toHaveBeenCalledWith([{ ...stored[0], quantity: 7 }]);
  });

  it('clear empties the cart and persists the emptiness', () => {
    store.add(product('p1'));
    store.clear();
    TestBed.tick();

    expect(store.lines()).toEqual([]);
    expect(write).toHaveBeenLastCalledWith([]);
  });

  it('a bare flush with no restore() and no mutation must not persist', () => {
    // This is the race from the bug report: the persistence effect is
    // scheduled once at construction, with the signal still holding the
    // value it was born with. If that first flush writes anything at all,
    // it overwrites whatever a slow restore() has not yet had the chance to
    // read back — the on-screen cart is fine, storage is gone. Nothing has
    // happened here — no restore(), no add/setQuantity/remove/clear — so a
    // flush of this state must be silent.
    //
    // TestBed.tick(), not `await Promise.resolve()`: under zoneless change
    // detection the effect is scheduled through
    // scheduleCallbackWithRafRace, not run synchronously on signal write,
    // and a bare microtask does not reliably land after that scheduling —
    // it would make this assertion pass or fail on timing luck rather than
    // on the guard actually working. TestBed.tick() flushes synchronously.
    TestBed.tick();

    expect(write).not.toHaveBeenCalled();
  });

  it('a cart the user emptied via clear() still persists, even though it is value-identical to the state the store was born with', () => {
    // Force the born-with flush to actually happen first, exactly as in the
    // race test above, WITHOUT clearing the spy afterwards — the point is to
    // count everything the effect ever wrote across both flushes. `[]` from
    // being born with no cart yet read, and `[]` from the user emptying a
    // cart via clear(), are equal in value and different only in identity.
    // A guard written against value ("is this array empty?" or, worse, a
    // `hydrated` boolean toggled by the born-with flush) would conflate the
    // two and could suppress the clear() write as well — silently, so a
    // deliberately emptied cart would come back full on the next reload.
    // Pre-fix, this fails for the opposite reason: nothing suppresses the
    // born-with flush, so it counts as a first (wrong) write and the total
    // is 2, not 1. Only an identity check against the exact born-with
    // object gets both halves right at once: the born-with flush silent,
    // the clear() flush loud.
    TestBed.tick();

    store.add(product('p1'));
    store.clear();
    TestBed.tick();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith([]);
  });
});
