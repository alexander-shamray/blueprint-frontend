import {
  ChangeDetectionStrategy, Component, LOCALE_ID, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel,
  IonList, IonListHeader, IonNote, IonSpinner, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { AuthService } from '@core/auth/auth.service';
import { PERMISSIONS, PlaceOrderCommand } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { ADDRESS_FIELDS, AddressField, splitAddressErrors } from './address-errors';
import { countryOptions } from './countries';

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
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel,
    IonList, IonListHeader, IonNote, IonSpinner, IonTitle, IonToolbar, ReactiveFormsModule,
    ErrorBannerComponent, MoneyPipe,
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
      <app-error-banner [error]="bannerError() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

      <form [formGroup]="form" (ngSubmit)="placeOrder()">
        <!--
          A 400's messages sit under the control they name (fieldErrors), and
          leave the banner, which keeps only the keys no control here owns.
          Each goes when its control is edited: the message was about the
          value that was sent, and that value is no longer the one on screen.
        -->
        <ion-item><ion-input label="Line 1" formControlName="line1" required></ion-input></ion-item>
        @for (message of fieldErrors().line1 ?? []; track $index) {
          <ion-note class="field-error" color="danger" data-field="line1">{{ message }}</ion-note>
        }
        <ion-item><ion-input label="Line 2" formControlName="line2"></ion-input></ion-item>
        @for (message of fieldErrors().line2 ?? []; track $index) {
          <ion-note class="field-error" color="danger" data-field="line2">{{ message }}</ion-note>
        }
        <ion-item><ion-input label="City" formControlName="city" required></ion-input></ion-item>
        @for (message of fieldErrors().city ?? []; track $index) {
          <ion-note class="field-error" color="danger" data-field="city">{{ message }}</ion-note>
        }
        <ion-item><ion-input label="Postal code" formControlName="postalCode" required></ion-input></ion-item>
        @for (message of fieldErrors().postalCode ?? []; track $index) {
          <ion-note class="field-error" color="danger" data-field="postalCode">{{ message }}</ion-note>
        }
        <!--
          A native select, not ion-select: it is labelled by a real <label>,
          a WebView renders it as the platform's own picker, and a browser
          test chooses an option by value rather than by driving an overlay.
        -->
        <ion-item>
          <label class="country" for="checkout-country">Country</label>
          <select id="checkout-country" formControlName="country" required>
            <option value="" disabled>Choose a country</option>
            @for (option of countries; track option.code) {
              <option [value]="option.code">{{ option.name }}</option>
            }
          </select>
        </ion-item>
        @for (message of fieldErrors().country ?? []; track $index) {
          <ion-note class="field-error" color="danger" data-field="country">{{ message }}</ion-note>
        }

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
          <!--
            The summary is the quote the cart handed over, line for line and
            number for number: what this order will be placed against, read
            off the reply and formatted, never added up here
            (client-architecture.md §9).
          -->
          <ion-list data-testid="order-summary">
            <ion-list-header><ion-label>Order summary</ion-label></ion-list-header>
            @for (line of quote.lines; track line.productId) {
              <ion-item>
                <ion-label>{{ line.name }}</ion-label>
                <ion-note slot="end">
                  {{ line.quantity }} × {{ line.amount | money: quote.currency }} =
                  {{ line.lineTotal | money: quote.currency }}
                </ion-note>
              </ion-item>
            }
            <ion-item>
              <ion-label><strong>Total</strong></ion-label>
              <ion-note slot="end"><strong>{{ quote.total | money: quote.currency }}</strong></ion-note>
            </ion-item>
          </ion-list>

          <ion-item>
            <ion-note>Ordering in {{ quote.currency }}, carried from the quote.</ion-note>
          </ion-item>
        }

        <!--
          rateLimit.blocked() joins the other refusals: a 429 says the platform
          will not take this order yet, and the banner above is counting the
          window down (spec §6). submitting() is the busy state — what the
          customer sees between the tap and the answer — and it changes the
          label only: the button stays live while the request is out, so a
          double-click still reaches the platform, as client-architecture.md
          §4 decides and placeOrder() below explains.
        -->
        <ion-button expand="block" type="submit"
          [disabled]="form.invalid || identity.isSpent() || !handoff.quote() || rateLimit.blocked()">
          @if (submitting()) {
            <ion-spinner name="dots" aria-hidden="true"></ion-spinner> Placing order…
          } @else {
            Place order
          }
        </ion-button>
      </form>

      <!--
        command.id_reused: the form stays on screen with the user's changes in
        it, because those changes are what was NOT applied, and this note is
        the page saying so in its own words — the banner above carries the
        platform's title and detail, which are addressed to a client rather
        than to a customer.
      -->
      @if (error()?.kind === 'idReused') {
        <ion-item>
          <ion-note>
            This order was already placed by an earlier submission from this page, so any changes
            you made since were not applied, and nothing was sent again. Its id cannot be shown
            here, because this refusal does not carry it; History lists every order this account
            has placed, this one included.
          </ion-note>
        </ion-item>
      }
    </ion-content>
  `,
  styles: `
    .field-error { display: block; padding: .25rem 1rem 0; font-size: .875rem; }
    .country { flex: 0 0 auto; margin-right: 1rem; }
    select { flex: 1; min-height: 2.75rem; background: transparent; color: inherit;
             border: none; font: inherit; }
  `,
})
export class CheckoutPage {
  private readonly ordering = inject(OrderingApi);
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);
  // Protected, not private: the template reads it directly (see the @if
  // guard below), the same convention CartPage.store uses.
  protected readonly handoff = inject(CheckoutHandoff);
  private readonly router = inject(Router);

  /**
   * Minted when the page is entered and held with the form. Every submission
   * uses it; only a success, an edit after a validation failure, or a change
   * of signed-in subject mints a new one. This is the one place the client
   * holds state across requests on purpose (spec §5.3).
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

  // Private-writable, public `asReadonly()` — the convention `CartStore.lines`,
  // `CommandIdentity.current`, `CatalogRefresh.current` and `CheckoutHandoff.quote`
  // all state: `readonly` on the field stops reassignment, not `.set()` from
  // outside. What this banner says about an order is decided by the response
  // this page read, and by nothing else.
  private readonly errorState = signal<DisplayError | null>(null);
  private readonly fieldErrorsState = signal<Partial<Record<AddressField, readonly string[]>>>({});
  // A count, not a flag: placeOrder() lets a double-click send two requests,
  // and the first answer to land must not clear the busy state while the
  // second is still out.
  private readonly inFlightState = signal(0);

  readonly error = this.errorState.asReadonly();
  /** A 400's messages for the controls on this form, by control. */
  readonly fieldErrors = this.fieldErrorsState.asReadonly();
  /** A request is out and its answer has not landed. */
  readonly submitting = computed(() => this.inFlightState() > 0);

  /**
   * What the banner shows: the mapped error, less the field messages a
   * control on this form already shows. A validation error whose every key
   * landed on a control keeps its title, so the banner still says the order
   * was refused and the controls say why.
   */
  readonly bannerError = computed<DisplayError | null>(() => {
    const error = this.errorState();
    if (error?.kind !== 'validation') return error;

    const { rest } = splitAddressErrors(error.fields);
    return { ...error, fields: Object.keys(rest).length > 0 ? rest : undefined };
  });

  protected readonly countries = countryOptions(inject(LOCALE_ID));

  /**
   * Spec §6's 429 row — the gateway's authenticated bucket, shared with Get
   * quote, Cancel order and Publish. Checkout is a PUSHED route rather than a
   * tab root, so the previous per-page countdown died with the page: leaving
   * and coming back mid-window built a fresh one at zero and the wait
   * silently vanished. This one outlives the navigation because the window
   * belongs to the session, not to the screen.
   */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  /**
   * One automatic replay per successful round trip. A 401 answered by a
   * sign-in that is itself answered by another 401 — an account that has
   * lost the permission, a realm mid-restart — would otherwise be an
   * unbounded loop of sign-in prompts, and a loop is not a replay.
   */
  private replayedAfterSignIn = false;

  /** Bumped each time the effect below clears the page for a different subject. */
  private subjectChanges = 0;

  /**
   * Carried from the quote, with no fallback — quoteGuard guarantees a quote
   * exists before this page is reachable. A `?? 'EUR'` here would be a guess
   * about money, and it would only ever be read on the path where the guess is
   * certainly wrong: no quote means nothing priced this basket in any currency.
   */
  readonly currency = computed(() => this.handoff.quote()!.currency);

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());

    for (const field of ADDRESS_FIELDS) {
      this.form.controls[field].valueChanges.subscribe(() => {
        if (this.fieldErrorsState()[field] === undefined) return;
        this.fieldErrorsState.update((errors) => {
          const remaining = { ...errors };
          delete remaining[field];
          return remaining;
        });
      });
    }

    // A different subject — a sign-out, or a sign-out and somebody else's
    // sign-in — starts the form again, as the order pages forget an order.
    // Checkout is pushed on the Cart tab and survives a native sign-out, so
    // without this the next buyer on the device would find the last one's
    // address filled in under a live Place order, and one tap would send it
    // as an order on their own account. The banner, the field messages and
    // the id go with the address: each was about a request the previous
    // buyer made. Compared with the last subject seen rather than the one
    // this page was built for, because a subject can come back; the first
    // run is the construction's own and does nothing.
    const user = this.auth.user();
    let lastSeen = untracked(() => user()?.subject ?? null);
    effect(() => {
      const subject = user()?.subject ?? null;
      if (subject === lastSeen) return;
      lastSeen = subject;
      untracked(() => {
        this.subjectChanges++;
        this.form.reset();
        this.errorState.set(null);
        this.fieldErrorsState.set({});
        this.replayedAfterSignIn = false;
        // A new form entry, as after a success: the old id was the previous
        // buyer's command, and idempotency keys on the subject anyway.
        this.identity.onSuccess();
      });
    });
  }

  placeOrder(): void {
    // Guards the same window the button's [disabled] binding guards, and for
    // the same reason: after a success or an already_committed,
    // handoff.clear() has run but router.navigate() has not resolved yet,
    // identity.isSpent() may already be false again (onSuccess() clears it),
    // and the form is still valid — so a click landing in that gap would
    // otherwise reach currency()'s assertion with a null quote. After an
    // id_reused there is no gap: the page stays, the quote stays null for the
    // rest of its life, and since this method never reads isSpent(), this
    // return is what refuses a resubmit. This is deliberately not an
    // in-flight guard: a double-click before any response lands still sends
    // two requests under the same commandId, and the platform answering the
    // second with request.in_progress is the idempotency mechanism working
    // as designed, not a bug this method should suppress. The button's busy
    // state is shown and the button stays enabled, so that double-click still
    // reaches the platform (client-architecture.md §4): the busy state tells
    // the customer the order is on its way, and this method still sends
    // whatever it is asked to.
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

    this.inFlightState.update((count) => count + 1);

    this.ordering.place(command).subscribe({
      next: (orderId) => {
        this.inFlightState.update((count) => count - 1);
        this.replayedAfterSignIn = false;
        this.errorState.set(null);
        this.fieldErrorsState.set({});
        this.identity.onSuccess();
        this.spendQuote();
        void this.router.navigate(['/tabs/cart/placed', orderId]);
      },
      error: (failure: HttpErrorResponse) => {
        this.inFlightState.update((count) => count - 1);
        const displayed = mapError(failure, { permission: PERMISSIONS.ordersWrite });
        this.errorState.set(displayed);
        // Replaced, not merged: every response is the whole of what the
        // platform said about the order just sent, and a field it no longer
        // names has no message to keep.
        this.fieldErrorsState.set(
          displayed.kind === 'validation' ? splitAddressErrors(displayed.fields).byField : {},
        );
        this.identity.onFailure(displayed);

        // command.already_committed: the earlier submission won. Treat it as
        // success pending confirmation and move to the placed page with a note
        // — there is no order id to show, because the platform no longer holds
        // the result. The placed page points at History, which lists it.
        if (displayed.kind === 'alreadyCommitted') {
          this.spendQuote();
          void this.router.navigate(['/tabs/cart/placed', ALREADY_COMMITTED]);
        }

        // command.id_reused: the earlier submission under this id was placed
        // — ADR-057 stores only a success's result, and refuses a different
        // command against it without running the handler — and THIS one,
        // which differs from it (the address, edited since), was not. So the
        // order exists and the basket is spent, as on a 200. The page does
        // not move: the placed page would tell the customer that the order
        // they just sent was placed, which is the one thing this response
        // rules out. Nor does it offer the edited order again under a new
        // id: that order is certainly a second one, and the first can be
        // checked on History before a deliberate second is made. onFailure() has
        // spent the identity, so Place order stays disabled; leaving and
        // coming back through the cart is how a deliberate second order is
        // made.
        if (displayed.kind === 'idReused') this.spendQuote();

        // Spec §6's 401 row: the caller invokes AuthService.signIn() and
        // replays after. What this page replays is THIS order, under the
        // commandId it already holds — `identity.onFailure()` above mints
        // nothing for a signIn kind, and no edit happens in between — so
        // the replay is a replay in the platform's sense too:
        // IdempotencyBehavior keys on subject, operation and commandId, and
        // a second POST under the same id is either the same order coming
        // back or a 409 that says so. That is exactly why auto-replaying
        // here is safe when auto-resubmitting a form generally is not.
        //
        // A 401 is also a refusal at the edge, before the handler: the order
        // it names was never placed. So the replay cannot duplicate one even
        // if the id had been fresh.
        if (displayed.kind === 'signIn') this.signInAndReplay();

        // request.in_progress and every other failure stay on this page. The
        // id is unchanged, so the user's next click is a replay rather than a
        // second order.
      },
    });
  }

  /**
   * Re-authenticate, then send the same order again.
   *
   * On the web this replay does not happen, and that is not a flaw in it:
   * `WebAuthStrategy.signIn()` is `initCodeFlow()`, a top-level navigation
   * to Keycloak, and the heap — this component, its CommandIdentity, the
   * handoff — is destroyed on the way out. The user comes back to a fresh
   * app at `/` (spec §4.1: a reload signs the web session out, and there is
   * no refresh token to avoid the round trip). The replay is written for
   * the interface, not for one strategy: the native strategy (spec §4.2)
   * returns from `signIn()` with the app still standing, and there the
   * customer gets their order placed instead of a banner and a form they
   * have to re-submit by hand.
   *
   * The rejection path is the one `CartPage.getQuote()` documents:
   * `signIn()` rejects with a bare string when discovery fails, which is
   * why `mapError` takes `unknown`.
   *
   * The replay goes out only when the subject that was refused is the one
   * signed in afterwards, as `OrderDetailPage`'s Cancel replay does. The
   * same commandId is the same command only for the same principal —
   * idempotency keys on the subject too — so a native sign-in that someone
   * else completes would otherwise place this basket, to this address, as
   * an order on their account that they never pressed Place order for. A
   * different subject, or none, finds the form started again by the
   * constructor's subject effect, and nothing is sent in their name. Nor is
   * anything replayed when that effect has cleared the form in between, even
   * for the same subject coming back: what it would send is no longer the
   * order that was refused.
   */
  private signInAndReplay(): void {
    const replay = !this.replayedAfterSignIn;
    this.replayedAfterSignIn = true;
    const refusedSubject = this.auth.user()()?.subject ?? null;
    const changesAtRefusal = this.subjectChanges;

    this.auth.signIn().then(
      () => {
        const sameSubject =
          refusedSubject !== null &&
          this.auth.user()()?.subject === refusedSubject &&
          this.subjectChanges === changesAtRefusal;
        if (replay && sameSubject) this.placeOrder();
      },
      (failure: unknown) => this.errorState.set(mapError(failure)),
    );
  }

  /**
   * The three paths that end the checkout flow — a 200,
   * command.already_committed and command.id_reused — need the same two
   * writes, and for the same reason: the order exists (or, for
   * already_committed, might as well), so the basket that produced it is
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
