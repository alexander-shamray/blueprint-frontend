import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CheckoutHandoff } from './checkout-handoff';

/**
 * The checkout page may only be entered with a quote in hand.
 *
 * The handoff lives in memory; the cart lives in Preferences. A reload on
 * /tabs/cart/checkout therefore arrives with lines but no quote, as does a
 * deep link and a back-navigation after a placed order cleared the handoff.
 * Sending that back to the cart is not defensive tidying — it is what lets the
 * checkout page read the currency from the quote without a fallback, and a
 * fallback currency is a guess about money.
 *
 * In core beside the handoff it reads, because a feature never imports another
 * feature (spec §3).
 */
export const quoteGuard: CanActivateFn = () => {
  if (inject(CheckoutHandoff).quote() !== null) return true;

  // A UrlTree, not `false`. Returning false cancels the navigation and leaves
  // the user on whatever was underneath — which, on a cold reload of this URL,
  // is nothing at all. Redirecting states where they ended up and puts Get
  // quote in front of them.
  return inject(Router).createUrlTree(['/tabs/cart']);
};
