import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { noSuchOrder, orderPathSegment } from './order-path';
import { CancelOrderReason, CancelOrderRequest, PlaceOrderCommand } from './types';

/**
 * Ordering.Api/Endpoints/OrderEndpoints.cs, through the gateway.
 *
 * There is no read here, and the omission is still the platform's rather than
 * this file's: Ordering exposes no endpoint that reads an order back, and
 * OrderingPermissions.cs says why there is no `orders:read` to require. The
 * buyer's order read is the BFF's projection (backend ADR-051), so it lives
 * on `OrdersApi`, beside this file rather than in it.
 */
@Injectable({ providedIn: 'root' })
export class OrderingApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.gatewayBaseUrl}/api/v1/orders`;

  /** Requires `orders:write`. Replies 200 with the new order's id. */
  place(command: PlaceOrderCommand): Observable<string> {
    return this.http.post<string>(this.base, command);
  }

  /**
   * Requires `orders:cancel`. Replies 204. The backend's ADR-087 accepts
   * `customer_request` alone on this route: any other `CancelReasons` code,
   * like an unknown one, is a 400 keyed `Reason`. The parameter is typed to
   * match, while CANCEL_REASONS keeps the whole vocabulary for reading
   * `cancelReason` off an order. The tracking detail
   * (`OrderDetailPage.USER_REASON`) says why the customer's reason is that one.
   */
  cancel(orderId: string, reason: CancelOrderReason): Observable<void> {
    const body: CancelOrderRequest = { reason };

    // One path segment or no request at all: `orderPathSegment` says why a
    // '.' or '..' id is refused rather than encoded.
    const segment = orderPathSegment(orderId);
    if (segment === null) return noSuchOrder();

    return this.http.post<void>(`${this.base}/${segment}/cancel`, body);
  }
}
