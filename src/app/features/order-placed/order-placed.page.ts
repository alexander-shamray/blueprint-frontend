import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
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

  readonly orderId = signal(this.route.snapshot.paramMap.get('id') ?? '');

  readonly cancelled = signal(false);
  readonly error = signal<DisplayError | null>(null);

  readonly alreadyCommitted = computed(() => this.orderId() === ALREADY_COMMITTED);
  readonly canCancel = computed(() => !this.alreadyCommitted() && this.orderId() !== '');

  cancel(): void {
    this.ordering.cancel(this.orderId(), OrderPlacedPage.USER_REASON).subscribe({
      next: () => {
        this.error.set(null);
        this.cancelled.set(true);
      },
      error: (failure: HttpErrorResponse) =>
        // The permission comes from the route's own knowledge of what it needs,
        // not from the response — the 403 deliberately names none.
        this.error.set(mapError(failure, { permission: PERMISSIONS.ordersCancel })),
    });
  }
}
