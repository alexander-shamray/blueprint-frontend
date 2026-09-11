import { Injectable, computed, inject, signal } from '@angular/core';
import { QuoteResponse } from '@core/api/types';
import { CartStore } from './cart.store';

/**
 * The quote the cart obtained, read by the checkout page and by the route
 * guard that gates `/tabs/cart/checkout`. In core because two features share
 * it — the same reason the cart store is here (spec §3).
 *
 * Contract, because a guard is only as trustworthy as the lifecycle of what
 * it reads: `CartPage.checkout()` is the only writer of a fresh quote; the
 * checkout page and its route guard are the only readers; and a quote is only
 * ever handed out while the basket it was priced for is still the basket the
 * customer has.
 *
 * That last clause used to be a rule callers had to remember — "whoever holds
 * a fact that would make this quote stale must call `clear()` in the same
 * beat" — and a caller did not. `CartPage.invalidateQuote()` cleared the
 * handoff when the CART PAGE's own steppers or currency select moved, but
 * `ProductsPage.addToCart()` goes through `CartStore.add()` and touches no
 * part of the cart page at all: quote on the Cart tab, switch to Products,
 * add a product, and the guard waved the customer into a checkout priced for
 * a basket they no longer had. (The platform reprices at order time, so they
 * were not charged the stale figure — but the one job of a quote is to say
 * what someone will pay, and it had said something false.)
 *
 * So invalidation is tied to the MUTATION rather than to the UI that
 * triggered it: `set()` records `CartStore.version` — bumped by every
 * mutation, from anywhere — and `quote` reports nothing once that version has
 * moved. `CartPage`'s currency select still calls `clear()`, because a
 * currency change is not a cart mutation and the store cannot see it.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutHandoff {
  private readonly cart = inject(CartStore);

  // Private-writable, public computed — the convention CartStore.lines,
  // CommandIdentity.current and CatalogRefresh.current all use. quoteGuard
  // makes this signal a route-reachability decision, not just a data
  // carrier, so `readonly` alone (which guards the field binding, not
  // `.set()`) is no longer enough: the guard's guarantee is only as strong
  // as the write contract, and the write contract belongs in the type, not
  // in this comment.
  //
  // The stored value carries the cart version it was quoted AT, not just the
  // quote: a quote is a statement about one specific basket, and storing the
  // two apart is what let them drift.
  private readonly quoteState = signal<{
    readonly quote: QuoteResponse;
    readonly cartVersion: number;
  } | null>(null);

  /**
   * The quote, or null once the basket has moved underneath it.
   *
   * A `computed` rather than an `effect` that nulls the stored value: the
   * guard and the checkout page must get the right answer on the very tick
   * the mutation happened, and an effect is scheduled rather than immediate
   * under zoneless change detection — a `router.navigate()` issued in the
   * same beat as an `add()` would be admitted by a guard reading a signal
   * that had not been re-run yet. A computed re-evaluates on read.
   */
  readonly quote = computed<QuoteResponse | null>(() => {
    const held = this.quoteState();
    if (held === null) return null;

    // Not `>=`: the version only ever moves forward, so "different" and
    // "newer" are the same fact, and an equality test says the honest thing
    // — this quote was priced for exactly the basket that is on screen.
    return held.cartVersion === this.cart.version() ? held.quote : null;
  });

  /**
   * Records the version the quote was priced at, so a quote cannot invalidate
   * itself the instant it is set: the basket that produced it is, by
   * definition, the basket at this moment.
   */
  set(quote: QuoteResponse): void {
    this.quoteState.set({ quote, cartVersion: this.cart.version() });
  }

  clear(): void {
    this.quoteState.set(null);
  }
}
