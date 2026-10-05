import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList,
  IonListHeader, IonNote, IonRefresher, IonRefresherContent, IonText, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { OrdersApi } from '@core/api/orders.api';
import { CancelReason, OrderDetail, PERMISSIONS } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { OrderStatusComponent, statusLabel } from '@shared/order-status.component';
import { SkeletonListComponent } from '@shared/skeleton-list.component';

/** One row of the timeline: a fact the BFF supplied, or a step it has not reached. */
export interface TimelineStep {
  readonly key: string;
  readonly label: string;
  /** The BFF's timestamp, displayed as sent; null for a step not reached yet. */
  readonly at: string | null;
  /** An unhappy ending, drawn as the last step of a finished timeline rather than as an error. */
  readonly ending: boolean;
}

/** The three members one `OrderCancelled` decides between (§10.7). */
const ENDINGS: readonly string[] = ['cancelled', 'out_of_stock', 'declined'];

/** The forward steps, in the BFF's rank order. Keyed by name, as `OrderTimeline` is. */
const FORWARD = [
  { key: 'placed', label: 'Placed' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
] as const;

/**
 * The timeline, from the facts the read carries and from nothing else (#95).
 *
 * Every timestamp is the BFF's, drawn where it is keyed; no step is derived
 * from another and no date is computed. Which shape is drawn is the status's
 * decision, because the status is the BFF's rank and the rank is what §10.7
 * says decides: an order that ended in a cancellation member shows the steps
 * it reached and then its ending, while one still moving shows every forward
 * step, the unreached ones as not reached yet. A refund is a fact beside the
 * status (§10.7's `refunded`), so it is appended after the ending it followed.
 */
export function timelineOf(order: OrderDetail): readonly TimelineStep[] {
  const ended = ENDINGS.includes(order.status);
  const steps: TimelineStep[] = FORWARD.filter(
    (step) => !ended || order.timeline[step.key] !== null,
  ).map((step) => ({ ...step, at: order.timeline[step.key], ending: false }));

  if (ended) {
    steps.push({
      key: order.status,
      label: statusLabel(order.status),
      at: order.timeline.cancelled,
      ending: true,
    });
  }

  if (order.refunded) {
    steps.push({ key: 'refunded', label: 'Refunded', at: order.refundedAt, ending: true });
  }

  return steps;
}

/**
 * The tracking detail, `GET /bff/v1/orders/{id}`, pushed on the History tab's
 * stack. Cancel lives here now (#95): it moved from Order placed with its
 * reason, its in-flight guard, its stale-response check and its sign-in
 * replay, each unchanged and each argued where it stands below.
 *
 * What it offers is decided by the read's `cancellable`, which §10.7 calls a
 * hint and not an authority: it is computed from a projection that lags
 * `Order.Cancel`, so the button can be offered for an order the command will
 * refuse with 422 `order.already_shipped`, and that refusal is still handled —
 * the banner shows the platform's own title and detail. After despatch the
 * hint reads false, and the page says why rather than offering a button and
 * translating the refusal afterwards.
 */
@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [
    DatePipe, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel,
    IonList, IonListHeader, IonNote, IonRefresher, IonRefresherContent, IonText, IonTitle,
    IonToolbar, ErrorBannerComponent, MoneyPipe, OrderStatusComponent, SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/orders"></ion-back-button></ion-buttons>
        <ion-title>Order</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-refresher slot="fixed" [disabled]="rateLimit.blocked()" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <app-error-banner [error]="error() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

      @if (loadError()) {
        <ion-button expand="block" fill="outline" [disabled]="rateLimit.blocked()"
          (click)="load()">Try again</ion-button>
      }

      @if (order(); as o) {
        <ion-item>
          <ion-label>
            <h2>Order</h2>
            <ion-text><code>{{ o.orderId }}</code></ion-text>
          </ion-label>
          <app-order-status slot="end" [status]="o.status" />
        </ion-item>

        <ion-list data-testid="timeline">
          <ion-list-header><ion-label>Progress</ion-label></ion-list-header>
          @for (step of timeline(); track step.key) {
            <ion-item [class.pending]="step.at === null" [class.ending]="step.ending">
              <ion-label>
                <h3>{{ step.label }}</h3>
                <p>
                  @if (step.at; as at) {
                    {{ at | date: 'medium' }}
                  } @else {
                    Not reached yet
                  }
                </p>
              </ion-label>
            </ion-item>
          }
        </ion-list>

        @if (o.shipment?.trackingNumber; as tracking) {
          <ion-item>
            <ion-label>
              <h3>Carrier tracking number</h3>
              <ion-text><code>{{ tracking }}</code></ion-text>
            </ion-label>
          </ion-item>
        }

        <ion-list>
          <ion-list-header><ion-label>Items</ion-label></ion-list-header>
          @for (line of o.lines; track $index) {
            <ion-item>
              <ion-label>
                <h3>{{ line.productName ?? 'Unnamed product' }}</h3>
                <p>{{ line.quantity }} × {{ line.unitPrice.amount | money: line.unitPrice.currency }}</p>
              </ion-label>
              <ion-note slot="end">{{ line.lineTotal.amount | money: line.lineTotal.currency }}</ion-note>
            </ion-item>
          } @empty {
            <ion-item>
              <ion-note>The platform has not recorded this order's items yet.</ion-note>
            </ion-item>
          }
          @if (o.total; as total) {
            <ion-item>
              <ion-label><strong>Total</strong></ion-label>
              <ion-note slot="end"><strong>{{ total.amount | money: total.currency }}</strong></ion-note>
            </ion-item>
          }
        </ion-list>

        @if (o.payment; as payment) {
          <ion-list>
            <ion-list-header><ion-label>Payment</ion-label></ion-list-header>
            @if (payment.amount; as amount) {
              <ion-item>
                <ion-label>
                  <h3>Authorised</h3>
                  @if (payment.authorisedAt; as at) {
                    <p>{{ at | date: 'medium' }}</p>
                  }
                </ion-label>
                <ion-note slot="end">{{ amount.amount | money: amount.currency }}</ion-note>
              </ion-item>
            }
            @if (payment.refundedAmount; as refunded) {
              <ion-item>
                <ion-label><h3>Refunded</h3></ion-label>
                <ion-note slot="end">{{ refunded.amount | money: refunded.currency }}</ion-note>
              </ion-item>
            }
          </ion-list>
        }

        @if (cancelled()) {
          <ion-item>
            <ion-note>
              Cancellation accepted: the platform answered 204. The progress above changes once the
              order read records it.
            </ion-note>
          </ion-item>
        } @else if (o.cancellable) {
          <ion-item>
            <ion-note>Cancelling here is recorded as the customer's own request.</ion-note>
          </ion-item>

          <!--
            Disabled for the length of a 429 window as well (spec §6). The
            banner above is counting the window down.
          -->
          <ion-button expand="block" [disabled]="rateLimit.blocked()" (click)="cancel()">
            Cancel order
          </ion-button>
        } @else if (cannotCancelReason(); as reason) {
          <ion-item><ion-note data-testid="cannot-cancel">{{ reason }}</ion-note></ion-item>
        }

        <ion-item>
          <ion-note>
            As the platform last recorded it, {{ o.asOf | date: 'medium' }}. Pull down to check again.
          </ion-note>
        </ion-item>
      } @else if (loading()) {
        <app-skeleton-list [rows]="4" />
      }
    </ion-content>
  `,
  styles: `
    .pending h3, .pending p { color: var(--ion-color-medium); }
    .ending h3 { font-weight: 600; }
  `,
})
export class OrderDetailPage {
  private readonly orders = inject(OrdersApi);
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
   * lands in the data operators read during one. The order read has since made
   * it visible to the buyer too: §10.7 keys the status on the origin first
   * precisely so that a user-origin `payment_declined` still reads `cancelled`.
   */
  private static readonly USER_REASON: CancelReason = 'customer_request';

  /** Reactive for the reason `OrderPlacedPage.orderId` gives: a reused route keeps emitting. */
  readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? '' },
  );

  private readonly orderState = signal<OrderDetail | null>(null);
  private readonly loadingState = signal(false);
  /** The read's failure, apart from a cancel's: only the read's offers Try again. */
  private readonly loadErrorState = signal<DisplayError | null>(null);
  private readonly cancelErrorState = signal<DisplayError | null>(null);
  private readonly cancelledState = signal(false);

  readonly order = this.orderState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly loadError = this.loadErrorState.asReadonly();
  readonly cancelled = this.cancelledState.asReadonly();
  readonly error = computed(() => this.cancelErrorState() ?? this.loadErrorState());

  readonly timeline = computed(() => {
    const order = this.orderState();
    return order === null ? [] : timelineOf(order);
  });

  /**
   * Why there is no button, said before anyone tries (#95). Only the two
   * shipping members need a sentence: an order that ended has a last step in
   * the timeline that already says so.
   */
  readonly cannotCancelReason = computed(() => {
    switch (this.orderState()?.status) {
      case 'dispatched':
        return 'This order has been dispatched, so it can no longer be cancelled.';
      case 'delivered':
        return 'This order has been delivered, so it can no longer be cancelled.';
      default:
        return null;
    }
  });

  /** Spec §6's 429 row — the gateway's authenticated bucket, which the read and the cancel share. */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  /** One automatic replay per round trip; see `signInAndReplay()` below. */
  private replayedAfterSignIn = false;

  /** True while a `cancel()` request is outstanding. See `cancel()` below. */
  private readonly cancelling = signal(false);

  constructor() {
    // Every id this instance is handed, the first included, is read once;
    // a later id also drops what the previous one left, as
    // `OrderPlacedPage`'s effect does, because a cancel note or a banner
    // belonging to order A must never stand under order B.
    effect(() => {
      this.orderId();
      untracked(() => {
        this.orderState.set(null);
        this.cancelledState.set(false);
        this.cancelErrorState.set(null);
        this.cancelling.set(false);
        this.load();
      });
    });
  }

  /** Reads the order again. A reply for an id this page has since left is dropped. */
  load(done?: () => void): void {
    const issuedForId = this.orderId();
    if (issuedForId === '') return;

    this.loadingState.set(true);
    this.loadErrorState.set(null);

    this.orders.get(issuedForId).subscribe({
      next: (order) => {
        done?.();
        if (this.orderId() !== issuedForId) return;
        this.loadingState.set(false);
        this.orderState.set(order);
      },
      error: (failure: HttpErrorResponse) => {
        done?.();
        if (this.orderId() !== issuedForId) return;
        this.loadingState.set(false);
        this.loadErrorState.set(mapError(failure));
      },
    });
  }

  refresh(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  cancel(): void {
    // Guarded outright, as it was on Order placed: `CancelOrderRequest`
    // carries no command id, so a second tap is a second, uncorrelated
    // command rather than a replay, and two concurrent writes to one order
    // can still surface EF's `request.concurrency_conflict` on the second.
    if (this.cancelling()) return;
    this.cancelling.set(true);

    // The id this request is FOR, captured at issue time, so a 204 for order
    // A landing after the route handed this instance order B is dropped rather
    // than put under B — and dropped BEFORE `cancelling` is released, so a
    // cancel the user has since started for B keeps its guard.
    const issuedForId = this.orderId();

    this.ordering.cancel(issuedForId, OrderDetailPage.USER_REASON).subscribe({
      next: () => {
        if (this.orderId() !== issuedForId) return;
        this.cancelling.set(false);
        this.replayedAfterSignIn = false;
        this.cancelErrorState.set(null);
        this.cancelledState.set(true);
        // The projection lags the command, so this read may still say
        // `placed`; the note above says the progress follows.
        this.load();
      },
      error: (failure: HttpErrorResponse) => {
        if (this.orderId() !== issuedForId) return;
        this.cancelling.set(false);
        // The permission comes from the route's own knowledge of what it
        // needs, not from the response — the 403 deliberately names none.
        const displayed = mapError(failure, { permission: PERMISSIONS.ordersCancel });
        this.cancelErrorState.set(displayed);

        // Spec §6's 401 row. A 401 is a refusal at the edge, before the
        // handler ever runs, so no cancellation was recorded and sending the
        // same one again after re-authenticating is the first one, arriving
        // with a token this time. Replayed for `issuedForId` alone.
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
   * top-level redirect and this page does not survive it (spec §4.1). It is
   * no longer the buyer's only route back to the order, though: History lists
   * it once they are signed in again. The native strategy (spec §4.2) returns
   * from `signIn()` with the page still standing, and there the cancellation
   * goes through instead of being retyped.
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
      (failure: unknown) => this.cancelErrorState.set(mapError(failure)),
    );
  }
}
