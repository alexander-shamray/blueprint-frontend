import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import type { CartLine } from './cart.store';

/**
 * One check per `CartLine` field, typed so that the two definitions cannot
 * drift apart silently: adding, renaming or removing a field on `CartLine`
 * fails compilation here until this table says how to read it (issue #9).
 * `quantity` is a positive integer because `CartStore.setQuantity` removes a
 * line rather than keep one at nought, so no write ever stores anything else.
 */
const FIELDS: { readonly [K in keyof CartLine]-?: (value: unknown) => boolean } = {
  productId: (value) => typeof value === 'string' && value !== '',
  name: (value) => typeof value === 'string',
  amount: (value) => typeof value === 'number' && Number.isFinite(value),
  currency: (value) => typeof value === 'string' && value !== '',
  quantity: (value) => typeof value === 'number' && Number.isInteger(value) && value > 0,
};

/**
 * A stored element as a `CartLine` holding only `CartLine`'s fields, or null
 * when it is not one. Copying rather than casting is what keeps an extra
 * stored field from riding into the store under a type that does not have it.
 */
function toCartLine(element: unknown): CartLine | null {
  if (typeof element !== 'object' || element === null) return null;
  const record = element as Record<string, unknown>;
  const line: Record<string, unknown> = {};
  for (const [field, isValid] of Object.entries(FIELDS)) {
    if (!isValid(record[field])) return null;
    line[field] = record[field];
  }
  return line as unknown as CartLine;
}

/**
 * Capacitor Preferences on every platform, which on the web is localStorage
 * behind the same interface. The cart is not a secret and not a credential —
 * that distinction is why the refresh token goes to secure storage (spec §4.2)
 * and this does not.
 */
@Injectable({ providedIn: 'root' })
export class CartPersistence {
  private static readonly KEY = 'blueprint.cart';

  async read(): Promise<readonly CartLine[]> {
    const { value } = await Preferences.get({ key: CartPersistence.KEY });
    if (!value) return [];

    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      // All or nothing. A cart with one unreadable line dropped is a different
      // cart presented as the customer's; an empty one is visibly lost, which
      // is what the corrupt-entry branch below already chooses.
      const lines = parsed.map(toCartLine);
      return lines.every((line) => line !== null) ? (lines as CartLine[]) : [];
    } catch {
      // A corrupt entry is an empty cart, not a crash on startup. Losing a
      // cart is recoverable; a shell that will not boot is not.
      return [];
    }
  }

  async write(lines: readonly CartLine[]): Promise<void> {
    await Preferences.set({ key: CartPersistence.KEY, value: JSON.stringify(lines) });
  }
}
