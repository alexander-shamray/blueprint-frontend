import { Injectable, signal } from '@angular/core';
import { QuoteResponse } from '@core/api/types';

/**
 * The quote the cart obtained, read by the checkout page. In core because two
 * features share it — the same reason the cart store is here (spec §3).
 */
@Injectable({ providedIn: 'root' })
export class CheckoutHandoff {
  readonly quote = signal<QuoteResponse | null>(null);
}
