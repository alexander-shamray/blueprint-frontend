import { Injectable, Signal, signal } from '@angular/core';
import { ProductSummary } from '@core/api/types';

/**
 * The stock levels the listing has seen this session, by product id, so the
 * cart can warn about a persisted line that now asks for more than is there.
 *
 * In core because two features need it and a feature never imports another
 * (spec §3): the products page is the only thing that reads the listing, and
 * the cart is what holds lines that outlive it. A `CartLine` does not carry
 * the level instead, because the persisted copy is a snapshot from whenever
 * the product was added — the warning is about "now", and the listing is the
 * only "now" the platform offers without a product read.
 *
 * A hint, never a gate. The reservation is Inventory's verdict and the order
 * already has a path for it to refuse, so nothing here blocks a quote or an
 * order — `client-architecture.md` §12 says why the listing's number cannot.
 *
 * Not persisted: a level from an earlier session is older than anything a
 * fresh listing will say, and the listing is the landing tab.
 */
@Injectable({ providedIn: 'root' })
export class CatalogAvailability {
  private readonly levels = signal<Readonly<Record<string, number | null>>>({});

  readonly current: Signal<Readonly<Record<string, number | null>>> = this.levels.asReadonly();

  /** Called with every page the listing receives; a later page's word replaces an earlier one's. */
  record(products: readonly ProductSummary[]): void {
    if (products.length === 0) return;

    this.levels.update((known) => ({
      ...known,
      ...Object.fromEntries(products.map((p) => [p.productId, p.quantityAvailable])),
    }));
  }

  /**
   * The level last seen, or `undefined` when the listing has not shown this
   * product this session. `null` is the platform's "never reported" and is
   * passed through, not folded into `undefined`: both mean "do not warn", but
   * they are different facts and a caller may want to say which.
   */
  of(productId: string): number | null | undefined {
    const known = this.levels();
    return Object.hasOwn(known, productId) ? known[productId] : undefined;
  }
}
