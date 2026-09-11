import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { CancelOrderRequest, CancelReason, PlaceOrderCommand } from './types';

/**
 * Ordering.Api/Endpoints/OrderEndpoints.cs, through the gateway.
 *
 * There is no read here, and the omission is the platform's rather than this
 * file's: Ordering exposes no endpoint that reads an order back, and
 * OrderingPermissions.cs says why there is no `orders:read` to require. The
 * order-placed screen states the consequence instead of inventing a status
 * (spec §5.4).
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
   * truthfully send is the caller's own question: the order-placed page
   * answers it with `customer_request` and explains why.
   */
  cancel(orderId: string, reason: CancelReason): Observable<void> {
    const body: CancelOrderRequest = { reason };

    // encodeURIComponent: orderId reaches here from a route param, which
    // Angular has already percent-decoded. A raw '/', '?' or '%' in it would
    // otherwise land in this template literal unescaped and turn into a
    // different path plus a query string rather than a single path segment.
    return this.http.post<void>(`${this.base}/${encodeURIComponent(orderId)}/cancel`, body);
  }
}
