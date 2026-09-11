import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
  IonText, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { AuthService } from '@core/auth/auth.service';
import { CancelReason, PERMISSIONS } from '@core/api/types';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RetryCountdown } from '@core/errors/retry-countdown';
import { ALREADY_COMMITTED } from '@core/commands/command-id';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.4. The page states, in one sentence, that the platform exposes no
 * order read — Ordering has no read endpoint and OrderingPermissions.cs says
 * why there is no `orders:read` to require. It does not poll, fake a status or
 * invent one.
 */
@Component({
  selector: 'app-order-placed',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
    IonText, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/cart"></ion-back-button></ion-buttons>
        <ion-title>Order placed</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <app-error-banner [error]="error()" [retryInSeconds]="rateLimit.remaining()" />

      @if (alreadyCommitted()) {
        <ion-item>
          <ion-label>
            <h2>Already committed</h2>
            <ion-note>
              The platform reported that this command id had already been applied, and it no longer
              holds the result. The order exists; its id is not recoverable from here.
            </ion-note>
          </ion-label>
        </ion-item>
      } @else {
        <ion-item>
          <ion-label>
            <h2>Order</h2>
            <ion-text><code>{{ orderId() }}</code></ion-text>
          </ion-label>
        </ion-item>
      }

      <ion-item>
        <ion-note>
          The platform exposes no endpoint that reads an order back, so no status is shown here.
        </ion-note>
      </ion-item>

      @if (canCancel()) {
        <ion-item>
          <ion-note>
            Cancelling here is recorded as the customer's own request.
          </ion-note>
        </ion-item>

        <!--
          Disabled for the length of a 429 window as well as after a
          cancellation the platform confirmed (spec §6). The banner above is
          counting the window down.
        -->
        <ion-button expand="block" [disabled]="cancelled() || rateLimit.blocked()"
          (click)="cancel()">Cancel order</ion-button>
      }

      @if (cancelled()) {
        <ion-item><ion-note>Cancelled. The platform answered 204.</ion-note></ion-item>
      }
    </ion-content>
  `,
})
export class OrderPlacedPage {
  private readonly ordering = inject(OrderingApi);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  /**
   * The ONLY reason a cancellation from this screen can truthfully carry.
   *
   * `CANCEL_REASONS` mirrors the whole wire vocabulary
   * (Common.Contracts/Ordering/V1/Commands.cs - `CancelReasons`) and that
   * mirror is right, but four of the five are facts the PLATFORM discovers:
   * out_of_stock and stock_timeout come from the fulfilment saga,
   * payment_declined and payment_timeout from Payments. None of them is a
   * choice a customer makes, and OrderEndpoints.cs stamps every cancellation
   * from this route `CommandOrigin.User` regardless of the code sent.
   *
   * So offering the list would let a customer record "cancelled because
   * payment was declined, origin user" - a statement about an incident that
   * did not happen. It is not cosmetic: the backend's own comment notes that
   * payment_declined and payment_timeout are one dimension value apart on the
   * orders.cancelled metric and a different incident, so a mis-picked code
   * lands in the data operators read during one.
   */
  private static readonly USER_REASON: CancelReason = 'customer_request';

  /**
   * Reactive, not a one-shot `route.snapshot` read. Angular's default
   * `RouteReuseStrategy` compares only `routeConfig` identity — params are
   * ignored — so navigating `placed/A` -> `placed/B` can hand this component
   * the SAME `ActivatedRoute` instance rather than constructing a fresh one.
   * `app.config.ts` now installs `IonicRouteStrategy`, which closes that gap
   * app-wide, but this page does not lean on a fact maintained three files
   * away: `paramMap` keeps emitting on a reused `ActivatedRoute` regardless
   * of which strategy is active (Angular's `advanceActivatedRoute` swaps
   * `snapshot` in place and emits on `paramsSubject` on every reuse, not
   * just a fresh activation), so reading it reactively is correct under
   * either strategy and the page is right on its own terms.
   */
  readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? '' },
  );

  // Private-writable, public `asReadonly()` — the convention `CartStore.lines`,
  // `CommandIdentity.current`, `CatalogRefresh.current` and `CheckoutHandoff.quote`
  // all state, and `cancelling` one line down already follows. `readonly` on the
  // field stops reassignment, not `.set()` from outside, and these two are this
  // page's record of what the PLATFORM answered for a specific order: a writer
  // anywhere else could put "Cancelled. The platform answered 204." on screen
  // for a cancellation that was never sent, which is the same false statement
  // `cancel()`'s id check below exists to prevent.
  private readonly cancelledState = signal(false);
  private readonly errorState = signal<DisplayError | null>(null);

  readonly cancelled = this.cancelledState.asReadonly();
  readonly error = this.errorState.asReadonly();

  /**
   * Spec §6's 429 row. After `error`, which it reads — field initialisers
   * run in order — and in the injection context its effect and DestroyRef
   * need.
   */
  readonly rateLimit = new RetryCountdown(this.error);

  /** One automatic replay per round trip; see `signInAndReplay()` below. */
  private replayedAfterSignIn = false;

  /** True while a `cancel()` request is outstanding. See `cancel()` below. */
  private readonly cancelling = signal(false);

  readonly alreadyCommitted = computed(() => this.orderId() === ALREADY_COMMITTED);
  readonly canCancel = computed(() => !this.alreadyCommitted() && this.orderId() !== '');

  constructor() {
    // Companion to the reactive `orderId` above: on a reused instance,
    // `cancelled`/`error` are leftovers from the PRIOR order and must not
    // bleed onto the next one's screen — showing "Cancelled. The platform
    // answered 204." for an order that was never touched would be exactly
    // the sentinel-as-real-id failure this branch keeps re-finding, one
    // signal over. Same idiom as `ProductsPage`'s `constructedAtVersion`
    // guard: an `effect()` runs once immediately on top of every signal it
    // reads, so the id seen right here — this construction's own initial
    // value — is remembered and skipped; only a LATER change (a different id
    // landing on this same instance) resets this page's state.
    const constructedForId = this.orderId();
    effect(() => {
      if (this.orderId() === constructedForId) return;
      this.cancelledState.set(false);
      this.errorState.set(null);
      // `cancelling` resets here too, and not only for tidiness: it is the
      // in-flight guard, so a cancel still outstanding for the PRIOR order
      // would otherwise leave the next order's Cancel button inert until that
      // unrelated response landed. Releasing it is safe because the response
      // it was guarding can no longer write anything — `cancel()` checks the
      // id before it touches any state.
      this.cancelling.set(false);
    });
  }

  cancel(): void {
    // `CancelOrderRequest` carries no command id — the wire body is
    // `{ reason }` alone — so, unlike checkout's `placeOrder()`, there is no
    // idempotency key here for a duplicate tap to replay under and nothing
    // for `request.in_progress` to demonstrate. Checkout deliberately lets a
    // double-click send two requests, because doing so exercises the real
    // mechanism; here a second tap would just be a second, uncorrelated
    // command, so it is guarded outright rather than left to the domain's
    // own idempotent `Order.Cancel` (harmless on its own, but two concurrent
    // writes to the same order can still surface EF's
    // `request.concurrency_conflict` on the second one).
    if (this.cancelling()) return;
    this.cancelling.set(true);

    // The id this request is FOR, captured at issue time. `orderId` is
    // reactive precisely because a reused instance can be handed a new `:id`
    // (see its comment above), and the effect in the constructor resets this
    // page's state when that happens — but it cannot reach a request already
    // in flight. Without this check, a 204 for order A landing after the route
    // handed this instance order B would put "Cancelled. The platform answered
    // 204." under order B, for a cancellation nobody sent for it. Same purpose
    // as `ProductsPage.generation` and `CartPage.generation`, keyed on the id
    // the page already tracks rather than on a counter beside it: the response
    // is dropped rather than applied, and it is dropped BEFORE `cancelling` is
    // released, so a cancel the user has since started for B keeps its guard.
    const issuedForId = this.orderId();

    this.ordering.cancel(issuedForId, OrderPlacedPage.USER_REASON).subscribe({
      next: () => {
        if (this.orderId() !== issuedForId) return;
        this.cancelling.set(false);
        this.replayedAfterSignIn = false;
        this.errorState.set(null);
        this.cancelledState.set(true);
      },
      error: (failure: HttpErrorResponse) => {
        if (this.orderId() !== issuedForId) return;
        this.cancelling.set(false);
        // The permission comes from the route's own knowledge of what it
        // needs, not from the response — the 403 deliberately names none.
        const displayed = mapError(failure, { permission: PERMISSIONS.ordersCancel });
        this.errorState.set(displayed);

        // Spec §6's 401 row. This page is the one of the four with no
        // commandId to replay under — `CancelOrderRequest` is `{ reason }`
        // and nothing else, as `cancel()` says above — so the argument for
        // replaying has to be made differently, and it is made by the status
        // code itself: a 401 is a refusal at the edge, before the handler
        // ever runs, so no cancellation was recorded. Sending the same
        // cancellation again after re-authenticating therefore cannot be a
        // second cancellation of anything; it is the first one, arriving
        // with a token this time. (Order.Cancel is idempotent in the domain
        // besides, which is a second line of defence, not the reason.)
        //
        // Replayed for `issuedForId` alone: this component is reused across
        // `:id` values (see `orderId` above), and a sign-in that resolves
        // after the route handed this instance a different order must not
        // cancel the new one on the old one's behalf.
        if (displayed.kind === 'signIn') this.signInAndReplay(issuedForId);
      },
    });
  }

  /**
   * Re-authenticate, then send the same cancellation again, at most once per
   * round trip — a 401 answered by a sign-in answered by another 401 is a
   * loop, not a replay.
   *
   * On the web the replay is unreachable: `WebAuthStrategy.signIn()` is a
   * top-level redirect to Keycloak and this page does not survive it (spec
   * §4.1), and the platform exposes no endpoint to find the order again
   * afterwards — which is precisely why the sign-in still has to be offered
   * rather than left as a dead banner: the session the customer is about to
   * lose is the only route they have back to this order id. The replay is
   * written for the interface; the native strategy (spec §4.2) returns from
   * `signIn()` with the page still standing, and there the cancellation goes
   * through instead of being retyped.
   */
  private signInAndReplay(issuedForId: string): void {
    const replay = !this.replayedAfterSignIn;
    this.replayedAfterSignIn = true;

    this.auth.signIn().then(
      () => {
        if (replay && this.orderId() === issuedForId && !this.cancelled()) this.cancel();
      },
      // `unknown`, not HttpErrorResponse: signIn() can reject with a bare
      // string when discovery fails (see CartPage.getQuote()).
      (failure: unknown) => this.errorState.set(mapError(failure)),
    );
  }
}
