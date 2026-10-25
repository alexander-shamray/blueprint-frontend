import { describe, expect, it } from 'vitest';
import { ClientToolRegistry } from '@core/assistant/client-tools';
import { OPENABLE_PAGES, shopTools } from './shop-tools';

const PRODUCT = '0b6f3c2e-8a1d-4c7e-9f00-1234567890ab';

function setup(options: { canPublish?: boolean; navigates?: boolean } = {}) {
  const opened: string[][] = [];
  const registry = new ClientToolRegistry();
  for (const tool of shopTools({
    navigate: async (commands) => {
      opened.push([...commands]);
      return options.navigates ?? true;
    },
    canPublish: () => options.canPublish ?? false,
  })) {
    registry.register(tool);
  }
  return { registry, opened };
}

describe('the shop UI tools', () => {
  it('are view tools only: read-only, not destructive, on the client side (design §6.3)', () => {
    const { registry } = setup();

    for (const descriptor of registry.descriptors()) {
      expect(descriptor.side).toBe('client');
      expect(descriptor.annotations.readOnlyHint).toBe(true);
      expect(descriptor.annotations.destructiveHint).toBe(false);
      // The action vocabulary the core refuses at registration.
      expect(descriptor.name).not.toMatch(
        /^(up|down|wipe|reset|replay|discard|execute|delete)$|^run_|^send_/,
      );
    }
  });

  it('opens a product and an order by id, lower-cased, as one path segment each', async () => {
    const { registry, opened } = setup();

    expect(await registry.run('open_product', { product_id: PRODUCT.toUpperCase() })).toEqual({
      ok: true,
      content: `Opened /tabs/products/${PRODUCT}.`,
    });
    expect(await registry.run('open_order', { order_id: PRODUCT })).toEqual({
      ok: true,
      content: `Opened /tabs/orders/${PRODUCT}.`,
    });
    expect(opened).toEqual([
      ['tabs', 'products', PRODUCT],
      ['tabs', 'orders', PRODUCT],
    ]);
  });

  it('refuses an id that is not a UUID, and navigates nowhere', async () => {
    const { registry, opened } = setup();

    for (const id of ['..', '../cart', 'abc', 42, undefined]) {
      expect((await registry.run('open_order', { order_id: id })).ok).toBe(false);
    }
    expect(opened).toEqual([]);
  });

  it('opens the cart, and each openable page', async () => {
    const { registry, opened } = setup({ canPublish: true });

    expect((await registry.run('open_cart', {})).ok).toBe(true);
    for (const page of OPENABLE_PAGES) {
      expect((await registry.run('open_page', { page })).ok).toBe(true);
    }

    expect(opened).toEqual([['tabs', 'cart'], ...OPENABLE_PAGES.map((page) => ['tabs', page])]);
  });

  it('refuses a page it does not know, and Publish to a customer who may not publish', async () => {
    const { registry, opened } = setup({ canPublish: false });

    expect((await registry.run('open_page', { page: 'checkout' })).ok).toBe(false);
    expect(await registry.run('open_page', { page: 'publish' })).toEqual({
      ok: false,
      content: 'this customer may not publish',
    });
    expect(opened).toEqual([]);
  });

  it('says so when the router refused the navigation', async () => {
    const { registry } = setup({ navigates: false });

    expect(await registry.run('open_cart', {})).toEqual({
      ok: false,
      content: 'the shop did not open that page',
    });
  });
});
