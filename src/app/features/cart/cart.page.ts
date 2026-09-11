import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonNote, IonSelect,
  IonSelectOption, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CheckoutApi } from '@core/api/checkout.api';
import { QuoteLine, QuoteResponse } from '@core/api/types';
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
              @if (quotedLines()[line.productId]; as quoted) {
                <ion-note>
                  {{ quoted.quantity }} × {{ quoted.amount }} {{ currency() }} =
                  {{ quoted.lineTotal }} {{ currency() }}
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
            <strong>Total: {{ q.total }} {{ q.currency }}</strong>
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

  /**
   * Bumped by `invalidateQuote()`. `getQuote()` captures the generation it
   * was called under and checks it again in both the success and error
   * branches when the response lands; a response whose generation no longer
   * matches was superseded by a quantity or currency change that invalidated
   * it, and is dropped rather than applied — the same shape, deliberately,
   * as `ProductsPage.generation` guards a `loadMore()` in flight against a
   * `reload()` that started a fresh sequence underneath it. Without this, a
   * `getQuote()` in flight when the user taps `+` or switches currency lands
   * AFTER `invalidateQuote()` has nulled the now-stale quote, and silently
   * restores a quote priced for a basket or currency that no longer exists —
   * exactly what `canCheckout()` exists to keep off screen.
   */
  private generation = 0;

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
   * The quoted lines by product id, so a cart line can find its own. Empty
   * before a quote exists.
   *
   * Every number in "2 × 12.50 = 25.00" is read off the reply and none of them
   * is computed here: `amount` is the unit price, `quantity` is what this
   * request asked for, and `lineTotal` is their product as the BFF worked it
   * out. The rule that the client never computes money has not moved — spec
   * §5.2, and QuoteResponse.cs's own reason for totalling server-side, that
   * "two clients computing a total is two places to get rounding wrong". What
   * has moved is that the platform now supplies the numbers the screen needs:
   * the request carries quantities, so `lineTotal` and `total` are the
   * basket's, and multiplying here would be the client doing arithmetic the
   * reply already contains.
   *
   * A record of LINES rather than of amounts, and that is what makes the
   * template's `@if (…; as quoted)` safe. A price of zero is legal
   * (PublishProductValidator.cs allows `GreaterThanOrEqualTo(0)`), so a record
   * of numbers had to be tested with `!== undefined` — truthiness would hide a
   * free product as though it had never been quoted. A line object is never
   * falsy, so the lookup missing is the only thing the guard can mean.
   */
  readonly quotedLines = computed<Readonly<Record<string, QuoteLine>>>(() => {
    const lines = this.quote()?.lines ?? [];
    return Object.fromEntries(lines.map((line) => [line.productId, line]));
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
    const generation = this.generation;

    // The cart's lines, quantities and all — the endpoint prices a basket
    // now, not a set of products. Mapped down to the two members the request
    // has rather than passed whole: a CartLine also carries the LISTING price
    // and the currency it was listed in, and the pricing endpoint has no
    // business being told what this client thought a product cost. The same
    // narrowing CheckoutPage does when it builds PlaceOrderItem.
    const lines = this.store
      .lines()
      .map((line) => ({ productId: line.productId, quantity: line.quantity }));

    this.checkoutApi.quote(lines, this.currency()).subscribe({
      next: (quote) => {
        // Superseded by an invalidateQuote() (a quantity or currency change)
        // that started a new generation while this request was in flight.
        // Applying it now would restore a quote for a basket or currency
        // that no longer exists.
        if (generation !== this.generation) return;

        this.errorState.set(null);
        this.quoteState.set(quote);
      },
      error: (failure: HttpErrorResponse) => {
        if (generation !== this.generation) return;

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
        //
        // mapError() takes the rejection as `unknown`, not `HttpErrorResponse`:
        // angular-oauth2-oidc's loadDiscoveryDocument(), which signIn() awaits,
        // can reject with a bare string rather than an HTTP error — there is no
        // response to type it as. See error-mapper.ts's non-HttpErrorResponse
        // branch, added for exactly this call.
        if (displayed.kind === 'signIn') {
          this.auth.signIn().catch((failure) => {
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
    //
    // Asserted non-null: the template only enables this button behind
    // canCheckout(), which requires a quote to exist. CheckoutHandoff.set()
    // takes QuoteResponse rather than QuoteResponse | null on purpose —
    // quoteGuard treats "a quote was set" as the route-reachability fact, and
    // a nullable setter would let that fact be asserted falsely.
    this.handoff.set(this.quote()!);
    void this.router.navigate(['/tabs/cart/checkout']);
  }

  /**
   * A quote describes a specific set of lines in a specific currency; change
   * either and it is stale. Nulling `quoteState` alone does not finish the
   * job: a `getQuote()` issued before the change may still be in flight, and
   * the checkout handoff may still hold what the stale quote produced.
   * Bumping `generation` drops that in-flight response when it lands, the
   * same way `ProductsPage.reload()` drops a superseded `loadMore()`;
   * clearing the handoff keeps the checkout route guard from trusting a
   * quote priced for a basket or currency that no longer exists.
   */
  private invalidateQuote(): void {
    this.generation++;
    this.quoteState.set(null);
    this.handoff.clear();
  }
}
