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
import { CancelReason, PERMISSIONS } from '@core/api/types';
import { DisplayError, mapError } from '@core/errors/error-mapper';
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
      <app-error-banner [error]="error()" />

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

        <ion-button expand="block" [disabled]="cancelled()" (click)="cancel()">Cancel order</ion-button>
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

  readonly cancelled = signal(false);
  readonly error = signal<DisplayError | null>(null);

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
    // landing on this same instance) resets the two signals.
    const constructedForId = this.orderId();
    effect(() => {
      if (this.orderId() === constructedForId) return;
      this.cancelled.set(false);
      this.error.set(null);
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

    this.ordering.cancel(this.orderId(), OrderPlacedPage.USER_REASON).subscribe({
      next: () => {
        this.cancelling.set(false);
        this.error.set(null);
        this.cancelled.set(true);
      },
      error: (failure: HttpErrorResponse) => {
        this.cancelling.set(false);
        // The permission comes from the route's own knowledge of what it
        // needs, not from the response — the 403 deliberately names none.
        this.error.set(mapError(failure, { permission: PERMISSIONS.ordersCancel }));
      },
    });
  }
}
