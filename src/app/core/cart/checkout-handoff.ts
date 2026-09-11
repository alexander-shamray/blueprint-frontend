import { Injectable, signal } from '@angular/core';
import { QuoteResponse } from '@core/api/types';

/**
 * The quote the cart obtained, read by the checkout page and by the route
 * guard that gates `/tabs/cart/checkout`. In core because two features share
 * it — the same reason the cart store is here (spec §3).
 *
 * Contract, because a guard is only as trustworthy as the lifecycle of what
 * it reads: `CartPage.checkout()` is the only writer of a fresh quote; the
 * checkout page and its route guard are the only readers; and whoever holds
 * a fact that would make this quote stale must call `clear()` in the same
 * beat, or the guard waves a stale quote through. `CartPage.invalidateQuote()`
 * is one such caller — a quote stale for the cart is stale for checkout too,
 * and the two must not be allowed to disagree. A later task's order
 * placement is expected to call `clear()` on success for the identical
 * reason: an emptied cart must not leave behind a quote priced for a basket
 * that no longer exists.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutHandoff {
  // Private-writable, public asReadonly() — the convention CartStore.lines,
  // CommandIdentity.current and CatalogRefresh.current all use. quoteGuard
  // now makes this signal a route-reachability decision, not just a data
  // carrier, so `readonly` alone (which guards the field binding, not
  // `.set()`) is no longer enough: the guard's guarantee is only as strong
  // as the write contract, and the write contract belongs in the type, not
  // in this comment.
  private readonly quoteState = signal<QuoteResponse | null>(null);

  readonly quote = this.quoteState.asReadonly();

  set(quote: QuoteResponse): void {
    this.quoteState.set(quote);
  }

  clear(): void {
    this.quoteState.set(null);
  }
}
