import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonNote,
  IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { PERMISSIONS, PlaceOrderCommand } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.3. The address form mirrors AddressDto's five fields with the same
 * required set — line2 optional — and the currency is carried from the quote
 * rather than picked again: pricing in one currency and ordering in another is
 * two different numbers with one label.
 */
@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonNote,
    IonTitle, IonToolbar, ReactiveFormsModule, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/cart"></ion-back-button></ion-buttons>
        <ion-title>Checkout</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <form [formGroup]="form" (ngSubmit)="placeOrder()">
        <ion-item><ion-input label="Line 1" formControlName="line1" required></ion-input></ion-item>
        <ion-item><ion-input label="Line 2" formControlName="line2"></ion-input></ion-item>
        <ion-item><ion-input label="City" formControlName="city" required></ion-input></ion-item>
        <ion-item><ion-input label="Postal code" formControlName="postalCode" required></ion-input></ion-item>
        <ion-item><ion-input label="Country" formControlName="country" required></ion-input></ion-item>

        <!--
          Reads the handoff directly, with optional chaining, rather than
          currency()'s non-null assertion. currency() is a template dependency
          of this view; on success and on already_committed this component
          calls handoff.clear() before router.navigate() resolves, which nulls
          the signal currency() reads. That alone is enough to mark it dirty —
          no other signal needs to change on the same tick, because a computed
          re-evaluates whenever ITS OWN dependency changes, not because
          something else in the template did. Zoneless CD then re-renders the
          still-mounted view on the next tick and currency() would throw on
          the now-null quote unconditionally. currency() itself stays
          asserted: placeOrder() reads the handoff directly too (see below)
          and returns before ever calling currency() with a null quote.
        -->
        @if (handoff.quote(); as quote) {
          <ion-item>
            <ion-note>Ordering in {{ quote.currency }}, carried from the quote.</ion-note>
          </ion-item>
        }

        <ion-button expand="block" type="submit"
          [disabled]="form.invalid || identity.isSpent() || !handoff.quote()">
          Place order
        </ion-button>
      </form>
    </ion-content>
  `,
})
export class CheckoutPage {
  private readonly ordering = inject(OrderingApi);
  private readonly cart = inject(CartStore);
  // Protected, not private: the template reads it directly (see the @if
  // guard below), the same convention CartPage.store uses.
  protected readonly handoff = inject(CheckoutHandoff);
  private readonly router = inject(Router);

  /**
   * Minted when the page is entered and held with the form. Every submission
   * uses it; only a success, or an edit after a validation failure, mints a
   * new one. This is the one place the client holds state across requests on
   * purpose (spec §5.3).
   */
  readonly identity = new CommandIdentity();

  readonly form = new FormGroup({
    line1: new FormControl('', { nonNullable: true, validators: Validators.required }),
    // Optional, exactly as AddressDto has it nullable.
    line2: new FormControl('', { nonNullable: true }),
    city: new FormControl('', { nonNullable: true, validators: Validators.required }),
    postalCode: new FormControl('', { nonNullable: true, validators: Validators.required }),
    country: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  readonly error = signal<DisplayError | null>(null);
  /**
   * Carried from the quote, with no fallback — quoteGuard guarantees a quote
   * exists before this page is reachable. A `?? 'EUR'` here would be a guess
   * about money, and it would only ever be read on the path where the guess is
   * certainly wrong: no quote means nothing priced this basket in any currency.
   */
  readonly currency = computed(() => this.handoff.quote()!.currency);

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());
  }

  placeOrder(): void {
    // Guards the same window the button's [disabled] binding guards, and for
    // the same reason: after a success or an already_committed, handoff.clear()
    // has run but router.navigate() has not resolved yet, identity.isSpent()
    // may already be false again (onSuccess() clears it), and the form is
    // still valid — so a click landing in that gap would otherwise reach
    // currency()'s assertion with a null quote. This is deliberately not an
    // in-flight guard: a double-click before any response lands still sends
    // two requests under the same commandId, and the platform answering the
    // second with request.in_progress is the idempotency mechanism working
    // as designed, not a bug this method should suppress.
    const quote = this.handoff.quote();
    if (quote === null) return;

    const address = this.form.getRawValue();

    const command: PlaceOrderCommand = {
      commandId: this.identity.current(),
      items: this.cart.lines().map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
      })),
      shippingAddress: {
        line1: address.line1,
        // Empty means absent. AddressDto's Line2 is nullable and the backend
        // reads null as "no second line"; an empty string is a second line
        // that happens to be blank, which is a different claim.
        line2: address.line2.trim() === '' ? null : address.line2,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
      },
      currency: quote.currency,
    };

    this.ordering.place(command).subscribe({
      next: (orderId) => {
        this.error.set(null);
        this.identity.onSuccess();
        this.spendQuote();
        void this.router.navigate(['/tabs/cart/placed', orderId]);
      },
      error: (failure: HttpErrorResponse) => {
        const displayed = mapError(failure, { permission: PERMISSIONS.ordersWrite });
        this.error.set(displayed);
        this.identity.onFailure(displayed);

        // command.already_committed: the earlier submission won. Treat it as
        // success pending confirmation and move to the placed page with a note
        // — there is no order id to show, because the platform no longer holds
        // the result and exposes no endpoint to read it back.
        if (displayed.kind === 'alreadyCommitted') {
          this.spendQuote();
          void this.router.navigate(['/tabs/cart/placed', ALREADY_COMMITTED]);
        }

        // request.in_progress and every other failure stay on this page. The
        // id is unchanged, so the user's next click is a replay rather than a
        // second order.
      },
    });
  }

  /**
   * Both paths that end the checkout flow — a 200 and command.already_committed
   * — need the same two writes, and for the same reason: the order exists (or,
   * for already_committed, might as well), so the basket that produced it is
   * spent. Clearing only the cart is half of that: quoteGuard reads the
   * handoff to decide whether this route is reachable at all, so a quote left
   * behind lets the user navigate back into checkout with an emptied cart and
   * be waved straight through. CartPage clears the handoff whenever the
   * basket or currency changes (invalidateQuote()); this is the other half of
   * that same contract, for the path where the basket empties because the
   * order was placed rather than edited.
   */
  private spendQuote(): void {
    this.cart.clear();
    this.handoff.clear();
  }
}
