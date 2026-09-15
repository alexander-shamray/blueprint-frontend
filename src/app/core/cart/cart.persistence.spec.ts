import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CartLine } from './cart.store';
import { CartPersistence } from './cart.persistence';

/**
 * The real plugin, over jsdom's `localStorage`, cleared around every test.
 *
 * The first version of this spec mocked `@capacitor/preferences` with
 * `vi.mock` and an in-memory `Map`, which is what issue #5 suggested. It
 * passed on Windows and failed on Linux CI, and the failure was the bad kind:
 * `vi.mock` was silently not applied, so the adapter talked to real
 * `localStorage` while the assertions read the `Map`. Nothing errored. Five
 * tests reported the WRONG answer — a leftover cart from the previous test
 * read as this test's result — and two passed by coincidence, because a
 * round trip through one store looks the same as a round trip through
 * another. A spec whose mock might or might not be installed, depending on
 * the machine, is worse than no mock at all: it does not fail, it lies.
 *
 * The mock is not fixable from here either. `Preferences` is a Proxy from
 * Capacitor's `registerPlugin` with no own properties, so `vi.spyOn` cannot
 * take (`The property "get" is not defined on the object`), and whether
 * `vi.mock` intercepts a bare specifier depends on how `@angular/build`'s
 * bundler resolved it on that platform — which is not a contract this spec
 * can rest on.
 *
 * So nothing is mocked. That is not a concession: the adapter is real, the
 * plugin is real, and the store beneath them is jsdom's `localStorage`, which
 * Vitest gives each spec FILE fresh, so no other spec can see or pollute it.
 * Clearing before and after each test closes the only remaining gap — the one
 * `tabs.page.spec.ts` warns about, where a spec depends on the order the
 * suite ran in. The result covers more than the mocked version did: it proves
 * this adapter works against Capacitor Preferences, which is the one thing a
 * `Map` standing in for the plugin could never show.
 *
 * Seeding and reading back go through `Preferences` rather than through
 * `localStorage` directly, deliberately. The plugin prefixes its keys
 * (`CapacitorStorage.blueprint.cart`), and a test that hardcoded the prefix
 * would be pinning Capacitor's internals instead of this adapter's contract.
 */
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
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [CartPersistence] });
    persistence = TestBed.inject(CartPersistence);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('reads an empty cart on first launch, when nothing has ever been stored', async () => {
    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('reads back exactly what it wrote', async () => {
    // Without this the failure-path tests below prove nothing: a `read` that
    // returned `[]` unconditionally would satisfy every one of them.
    await persistence.write([line('p1'), line('p2', 3)]);

    await expect(persistence.read()).resolves.toEqual([line('p1'), line('p2', 3)]);
  });

  it('reads a cart stored under blueprint.cart by an earlier version of the app', async () => {
    // The key is a compatibility contract, not a constant: every customer who
    // has ever used this app has a cart sitting at this string, and renaming
    // it orphans all of them silently — an empty cart on next launch, no
    // error anywhere. Seeding with the literal rather than importing the
    // constant is the whole point; importing it would make the test agree
    // with any rename it was asked to agree with.
    await Preferences.set({ key: STORED_KEY, value: JSON.stringify([line('p1')]) });

    await expect(persistence.read()).resolves.toEqual([line('p1')]);
  });

  it('writes where a later read will find it — under blueprint.cart', async () => {
    await persistence.write([line('p1')]);

    const stored = await Preferences.get({ key: STORED_KEY });
    expect(stored.value).toBe(JSON.stringify([line('p1')]));
  });

  it('treats a corrupt entry as an empty cart rather than throwing', async () => {
    // The most consequential line in the file. `CartStore` hydrates from this
    // in its constructor, so a throw here is not a lost cart — it is a root
    // store that cannot be built, which is a blank app on launch.
    await Preferences.set({ key: STORED_KEY, value: '{ not json' });

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('treats stored JSON that is not an array as an empty cart', async () => {
    // `{"productId":"p1"}` parses perfectly well and is not a cart. Without
    // the `Array.isArray` guard it reaches `CartStore` as an object, and the
    // failure surfaces later and somewhere else.
    await Preferences.set({ key: STORED_KEY, value: JSON.stringify({ productId: 'p1' }) });

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('treats a stored JSON null as an empty cart', async () => {
    // `JSON.parse('null')` returns null, which is neither falsy at the string
    // level — so the `!value` early return does not catch it — nor an array.
    // It is the one input that reaches the `Array.isArray` guard as the only
    // thing standing between storage and `CartStore`.
    await Preferences.set({ key: STORED_KEY, value: 'null' });

    await expect(persistence.read()).resolves.toEqual([]);
  });

  // Issue #9: `Array.isArray` answers the shape question one level deep, and
  // every case below passed it — reaching `CartStore` as lines whose fields
  // are `undefined`, rendering `NaN` and sending an `undefined` productId to
  // the quote. Each is one element that is not a `CartLine`.
  it.each<[string, unknown]>([
    ['a number', 1],
    ['null', null],
    ['an empty object', {}],
    ['a line missing its productId', { ...line('p1'), productId: undefined }],
    ['a line whose productId is empty', { ...line('p1'), productId: '' }],
    ['a line whose amount is a string', { ...line('p1'), amount: '10' }],
    ['a line whose currency is missing', { ...line('p1'), currency: undefined }],
    ['a line whose name is not a string', { ...line('p1'), name: 42 }],
    ['a line whose quantity is zero', { ...line('p1'), quantity: 0 }],
    ['a line whose quantity is fractional', { ...line('p1'), quantity: 1.5 }],
  ])('treats a stored array holding %s as an empty cart', async (_, element) => {
    await Preferences.set({ key: STORED_KEY, value: JSON.stringify([element]) });

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('treats the whole cart as empty when one line of several is malformed', async () => {
    // Not a filter. A cart missing one line the customer put in it is a
    // different cart shown as theirs; an empty one is visibly a lost cart,
    // which is the posture the corrupt-entry case already takes.
    await Preferences.set({
      key: STORED_KEY,
      value: JSON.stringify([line('p1'), { productId: 'p2' }]),
    });

    await expect(persistence.read()).resolves.toEqual([]);
  });

  it('keeps only the CartLine fields of a stored line', async () => {
    // A stored line with an extra field is still a readable cart, but the
    // extra field must not ride into the store under the CartLine type.
    await Preferences.set({
      key: STORED_KEY,
      value: JSON.stringify([{ ...line('p1'), stray: true }]),
    });

    await expect(persistence.read()).resolves.toEqual([line('p1')]);
  });
});
