import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import type { CartLine } from './cart.store';

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
      return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
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
