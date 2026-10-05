import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { noSuchOrder, orderPathSegment } from './order-path';
import { CancelOrderRequest, CancelReason, PlaceOrderCommand } from './types';

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
   * Requires `orders:cancel`. Replies 204. An unknown reason code would be a
   * 400 keyed `Reason` — the backend refuses a code it does not know rather
   * than defaulting, so CANCEL_REASONS is the whole vocabulary and a caller
   * may send nothing outside it. Which of the five a given caller may
   * truthfully send is the caller's own question: the tracking detail
   * (`OrderDetailPage.USER_REASON`) answers it with `customer_request` and
   * explains why.
   */
  cancel(orderId: string, reason: CancelReason): Observable<void> {
    const body: CancelOrderRequest = { reason };

    // One path segment or no request at all: `orderPathSegment` says why a
    // '.' or '..' id is refused rather than encoded.
    const segment = orderPathSegment(orderId);
    if (segment === null) return noSuchOrder();

    return this.http.post<void>(`${this.base}/${segment}/cancel`, body);
  }
}
