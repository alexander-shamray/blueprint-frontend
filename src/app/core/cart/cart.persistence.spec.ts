import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CartLine } from './cart.store';
import { CartPersistence } from './cart.persistence';

/**
 * The plugin is mocked, and jsdom's `localStorage` deliberately is not used.
 *
 * Capacitor Preferences on the web IS `localStorage`, so a spec that let the
 * real plugin through would read and write the machine's storage — the hazard
 * `tabs.page.spec.ts` already records. Every other spec in this suite avoids
 * it by stubbing `CartPersistence` itself, which is precisely why this
 * adapter — the one module that actually talks to the plugin — has never
 * executed. Mocking one level lower is what lets it run at all: the adapter
 * under test is real, only the storage beneath it is in memory.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports, so a
 * plain `const` declared here would still be in its temporal dead zone when
 * the factory runs.
 */
const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    // `{ value: null }` for a missing key, which is what the real plugin
    // returns — not `undefined`, and not a rejection. Mirroring that exactly
    // is the difference between testing the first-launch path and testing a
    // shape the plugin never produces.
    get: async ({ key }: { key: string }) => ({ value: storage.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      storage.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      storage.delete(key);
    },
    clear: async () => {
      storage.clear();
    },
  },
}));

/** The key this adapter has always used. Named here, not imported: see below. */
const STORED_KEY = 'blueprint.cart';

const line = (productId: string, quantity = 1): CartLine => ({
  productId,
  name: `Product ${productId}`,
  amount: 10,
  currency: 'EUR',
  quantity,
});

describe('CartPersistence', () => {
  let persistence: CartPersistence;

  beforeEach(() => {
    storage.clear();
    TestBed.configureTestingModule({ providers: [CartPersistence] });
    persistence = TestBed.inject(CartPersistence);
  });

  it('reads an empty cart on first launch, when nothing has ever been stored', async () => {
    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('reads back exactly what it wrote', async () => {
    // Without this the three failure-path tests below prove nothing: a `read`
    // that returned `[]` unconditionally would satisfy every one of them.
    await persistence.write([line('p1'), line('p2', 3)]);

    await expect(persistence.read()).resolves.toEqual([line('p1'), line('p2', 3)]);
  });

  it('reads a cart stored under blueprint.cart by an earlier version of the app', async () => {
    // The key is a compatibility contract, not a constant: every customer who
    // has ever used this app has a cart sitting at this string, and renaming
    // it orphans all of them silently — an empty cart on next launch, no
    // error anywhere. Seeding storage with the literal rather than importing
    // the constant is the whole point; importing it would make the test agree
    // with any rename it was asked to agree with.
    storage.set(STORED_KEY, JSON.stringify([line('p1')]));

    await expect(persistence.read()).resolves.toEqual([line('p1')]);
  });

  it('writes where a later read will find it — under blueprint.cart', async () => {
    await persistence.write([line('p1')]);

    expect(storage.get(STORED_KEY)).toBe(JSON.stringify([line('p1')]));
  });

  it('treats a corrupt entry as an empty cart rather than throwing', async () => {
    // The most consequential line in the file. `CartStore` hydrates from this
    // in its constructor, so a throw here is not a lost cart — it is a root
    // store that cannot be constructed, which is a blank app on launch.
    storage.set(STORED_KEY, '{ not json');

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('treats stored JSON that is not an array as an empty cart', async () => {
    // `{"productId":"p1"}` parses perfectly well and is not a cart. Without
    // the `Array.isArray` guard it reaches `CartStore` as an object, and the
    // store spreads it — so the failure surfaces later and somewhere else.
    storage.set(STORED_KEY, JSON.stringify({ productId: 'p1' }));

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('treats a stored JSON null as an empty cart', async () => {
    // `JSON.parse('null')` returns null, which is neither falsy-at-the-string
    // -level (so the `!value` early return does not catch it) nor an array.
    // It is the one input that reaches the `Array.isArray` guard as the only
    // thing standing between storage and `CartStore`.
    storage.set(STORED_KEY, 'null');

    await expect(persistence.read()).resolves.toEqual([]);
  });
});
