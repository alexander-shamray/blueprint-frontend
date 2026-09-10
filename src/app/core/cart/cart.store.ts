import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';

/**
 * The backend has no cart, so the cart is client state (spec §3). `amount` is
 * the LISTING price, and the cart labels it as such: the quote is the price
 * that counts, and it comes from the BFF.
 */
export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly amount: number;
  readonly currency: string;
  readonly quantity: number;
}

/**
 * In core rather than in a feature, because two features share it — the
 * products page writes and the cart and checkout pages read. That sharing is
 * the whole reason spec §3 puts it here instead of under features/cart.
 */
@Injectable({ providedIn: 'root' })
export class CartStore {
  private readonly persistence = inject(CartPersistence);
  private readonly state = signal<readonly CartLine[]>([]);
  // Set to the exact array `restore()` just handed to `state.set`, so the
  // effect below can recognise "this run is the echo of a restore" and
  // suppress the write-back. A boolean flag cleared synchronously in a
  // `finally` block does NOT work here: under zoneless change detection the
  // effect is scheduled, not run synchronously on signal write, so by the
  // time it runs a boolean would already have been reset back to false and
  // the guard would never fire. Reference identity survives that delay
  // regardless of how many ticks pass before the effect is flushed.
  private pendingRestore: readonly CartLine[] | null = null;

  readonly lines = this.state.asReadonly();
  readonly count = computed(() => this.state().reduce((total, line) => total + line.quantity, 0));
  readonly isEmpty = computed(() => this.state().length === 0);
  readonly productIds = computed(() => this.state().map((line) => line.productId));

  constructor() {
    effect(() => {
      const lines = this.state();
      // Not the echo of a restore: writing back what was just read is a
      // wasted round trip, and on a slow device it can race the read it
      // followed.
      if (lines === this.pendingRestore) {
        this.pendingRestore = null;
        return;
      }
      void this.persistence.write(lines);
    });
  }

  async restore(): Promise<void> {
    const lines = await this.persistence.read();
    this.pendingRestore = lines;
    this.state.set(lines);
  }

  add(product: ProductSummary): void {
    this.state.update((lines) => {
      const existing = lines.find((line) => line.productId === product.productId);

      return existing
        ? lines.map((line) =>
            line.productId === product.productId ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [
            ...lines,
            {
              productId: product.productId,
              name: product.name,
              amount: product.amount,
              currency: product.currency,
              quantity: 1,
            },
          ];
    });
  }

  setQuantity(productId: string, quantity: number): void {
    // Zero and negative both remove. A stepper that can reach zero is the
    // ordinary way a line is deleted, and PlaceOrderItem has no meaning at a
    // quantity of nought.
    this.state.update((lines) =>
      quantity <= 0
        ? lines.filter((line) => line.productId !== productId)
        : lines.map((line) => (line.productId === productId ? { ...line, quantity } : line)),
    );
  }

  remove(productId: string): void {
    this.setQuantity(productId, 0);
  }

  clear(): void {
    this.state.set([]);
  }
}
