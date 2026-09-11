import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonNote, IonSelect,
  IonSelectOption, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CheckoutApi } from '@core/api/checkout.api';
import { QuoteResponse } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/** Spec §5.2. */
@Component({
  selector: 'app-cart',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonNote, IonSelect,
    IonSelectOption, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Cart</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <ion-list>
        @for (line of lines(); track line.productId) {
          <ion-item>
            <ion-label>
              <h2>{{ line.name }}</h2>
              <ion-note>
                Listing price {{ line.amount }} {{ line.currency }} — the quote is the price that counts
              </ion-note>
              @if (quotedPrices()[line.productId] !== undefined) {
                <ion-note>
                  Quoted {{ quotedPrices()[line.productId] }} {{ currency() }} each
                  &times; {{ line.quantity }}
                </ion-note>
              }
              @if (isUnpriced(line.productId)) {
                <ion-note color="warning">Not priced in {{ currency() }}</ion-note>
              }
            </ion-label>

            <ion-button slot="end" fill="clear"
              (click)="setQuantity(line.productId, line.quantity - 1)">−</ion-button>
            <ion-note slot="end">{{ line.quantity }}</ion-note>
            <ion-button slot="end" fill="clear"
              (click)="setQuantity(line.productId, line.quantity + 1)">+</ion-button>
          </ion-item>
        }
      </ion-list>

      <ion-item>
        <ion-select label="Currency" [value]="currency()"
          (ionChange)="setCurrency($any($event).detail.value)">
          @for (code of currencies; track code) {
            <ion-select-option [value]="code">{{ code }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-button expand="block" [disabled]="store.isEmpty()" (click)="getQuote()">Get quote</ion-button>

      @if (quote(); as q) {
        <ion-item>
          <ion-label>
            <strong>Quoted unit prices: {{ q.total }} {{ q.currency }}</strong>
            <ion-note>
              One unit of each product. The platform prices products, not baskets —
              the amount charged is computed when the order is placed.
            </ion-note>
          </ion-label>
        </ion-item>
      }

      <ion-button expand="block" [disabled]="!canCheckout()" (click)="checkout()">Checkout</ion-button>
    </ion-content>
  `,
})
export class CartPage {
  private readonly checkoutApi = inject(CheckoutApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly handoff = inject(CheckoutHandoff);

  protected readonly store = inject(CartStore);
  /**
   * A convenience selection, NOT a platform vocabulary — which is why it is
   * three codes and not a mirrored constant. The backend constrains currency
   * only as `^[A-Za-z]{3}\z` (Catalog PublishProductValidator.cs, Ordering
   * PlaceOrderValidator.cs): any three letters are legal. Listing three without
   * saying so would read as "the platform supports three currencies", which is
   * false, and the citation rule exists to keep those two apart.
   */
  protected readonly currencies = ['EUR', 'GBP', 'USD'] as const;

  readonly lines = this.store.lines;

  // Writable privately, readonly to everyone else — the shape CartStore.lines
  // and CommandId.current already use. `readonly` alone guards the field
  // binding, not `.set()`, and the checkout page holds a reference to this
  // service's neighbours.
  private readonly currencyState = signal<string>('EUR');
  private readonly quoteState = signal<QuoteResponse | null>(null);
  private readonly errorState = signal<DisplayError | null>(null);

  readonly currency = this.currencyState.asReadonly();
  readonly quote = this.quoteState.asReadonly();
  readonly error = this.errorState.asReadonly();

  /**
   * Enabled only when a quote exists and prices every line. The BFF names the
   * gap in `unpriced` rather than failing, so the client must read it — an
   * order placed for a line nothing could price is an order for a product the
   * platform has no price for.
   */
  readonly canCheckout = computed(() => {
    const q = this.quote();
    return q !== null && q.unpriced.length === 0 && !this.store.isEmpty();
  });

  isUnpriced(productId: string): boolean {
    return this.quote()?.unpriced.includes(productId) ?? false;
  }

  /**
   * Quoted price of ONE unit, by product id. Empty before a quote exists.
   *
   * Shown beside the quantity rather than multiplied by it. CheckoutEndpoints.cs
   * totals `lines.Sum(line => line.Amount)` over `productId.Distinct()`, and the
   * request carries no quantities at all, so the reply's `total` is the sum of
   * one unit of each distinct product — NOT the basket. Spec 5.2's rule that the
   * client never sums money stands; what was wrong was calling that number a
   * basket total. Multiplying here would be the client computing money, which is
   * exactly what QuoteResponse.cs computes Total server-side to prevent.
   *
   * A record rather than a method, and the template tests `!== undefined` rather
   * than truthiness: a price of zero is legal (PublishProductValidator.cs allows
   * `GreaterThanOrEqualTo(0)`), and `@if (price; as p)` would hide a free product
   * as though it had never been quoted.
   */
  readonly quotedPrices = computed<Readonly<Record<string, number>>>(() => {
    const lines = this.quote()?.lines ?? [];
    return Object.fromEntries(lines.map((line) => [line.productId, line.amount]));
  });

  setQuantity(productId: string, quantity: number): void {
    this.store.setQuantity(productId, quantity);
    this.invalidateQuote();
  }

  setCurrency(currency: string): void {
    this.currencyState.set(currency);
    this.invalidateQuote();
  }

  getQuote(): void {
    this.checkoutApi.quote(this.store.productIds(), this.currency()).subscribe({
      next: (quote) => {
        this.errorState.set(null);
        this.quoteState.set(quote);
      },
      error: (failure: HttpErrorResponse) => {
        const displayed = mapError(failure);
        this.errorState.set(displayed);
        this.quoteState.set(null);

        // The quote requires sign-in; the button prompts for it (spec §5.2).
        //
        // .catch(), not a bare `void`. signIn() rejects when the identity
        // provider is unreachable: WebAuthStrategy retries the discovery
        // document there, because initCodeFlow() with no loginUrl silently
        // does nothing rather than navigating. Under `void` that rejection
        // becomes an unhandled promise rejection and the user gets a sign-in
        // button that appears to do nothing — the same class of bug as the
        // blank app the initializer fix removed, one layer up.
        if (displayed.kind === 'signIn') {
          this.auth.signIn().catch((failure: HttpErrorResponse) => {
            this.errorState.set(mapError(failure));
          });
        }
      },
    });
  }

  checkout(): void {
    // The quote travels through core rather than through a route parameter: a
    // QuoteResponse does not belong in a URL, and a feature never imports
    // another feature (spec §3).
    this.handoff.quote.set(this.quote());
    void this.router.navigate(['/tabs/cart/checkout']);
  }

  /** A quote describes a specific set of lines in a specific currency. Change either and it is stale. */
  private invalidateQuote(): void {
    this.quoteState.set(null);
  }
}
