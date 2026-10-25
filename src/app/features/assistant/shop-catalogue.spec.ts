import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shopCatalogue } from './shop-catalogue';

/** The paths `app.routes.ts` declares, read as text: a feature does not import the root. */
const ROUTES = [
  ...readFileSync(join(process.cwd(), 'src', 'app', 'app.routes.ts'), 'utf8').matchAll(
    /path: '([^']*)'/g,
  ),
].map((m) => m[1]);

/** `/tabs/orders/{orderId}` as the route that serves it, `orders/:id`. */
function routeOf(where: string): RegExp {
  const path = where.replace(/^\/tabs\//, '').replace(/\{\w+\}/g, '\u0000');
  const pattern = path
    .split('\u0000')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(':\\w+');
  return new RegExp(`^${pattern}$`);
}

describe('the shop catalogue (design §6.1)', () => {
  it('gives every page an id of its own, a label, and help of two sentences or more', () => {
    const entries = shopCatalogue(true);

    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.label.trim()).not.toBe('');
      expect(
        entry.help.split(/[.!?](?:\s|$)/).filter((s) => s.trim() !== '').length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('places every page at a route the shell actually serves', () => {
    expect(ROUTES.length).toBeGreaterThan(5);

    const unrouted = shopCatalogue(true)
      .map((entry) => entry.where)
      .filter((where) => !ROUTES.some((path) => routeOf(where).test(path)));

    expect(unrouted).toEqual([]);
  });

  it('lists Publish only for a customer who may publish', () => {
    expect(shopCatalogue(false).map((e) => e.id)).not.toContain('publish');
    expect(shopCatalogue(true).map((e) => e.id)).toContain('publish');
  });
});
