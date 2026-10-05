import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { CursorPage, OrderDetail, OrderSummary } from './types';

/**
 * Web.Bff/Endpoints/OrderEndpoints.cs, through the gateway's `/bff`
 * namespace — the buyer's order read, backend §10.7 and ADR-051. It is the
 * BFF's and not Ordering's: a projection the BFF owns, which calls nothing on
 * read. The path repeats Ordering's `/v1/orders` deliberately, and `/bff`
 * rather than `/api` is what keeps the two apart.
 *
 * Reads only. Placing and cancelling stay on `OrderingApi`, because those are
 * Ordering's commands and this file must not grow a second route to them.
 *
 * The subject is bound from the principal and never from the request, so
 * there is no customer id to send — and another buyer's order answers 404,
 * not 403, which `mapError()` shows as the backend's own title and detail.
 */
@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.gatewayBaseUrl}/bff/v1/orders`;

  /**
   * Authenticated at the edge and at the BFF's route group. `limit` is
   * clamped server-side (`OrderPage.Clamp`), so nothing here bounds it.
   */
  list(cursor: string | null, limit = 20): Observable<CursorPage<OrderSummary>> {
    let params = new HttpParams().set('limit', limit);
    if (cursor !== null) params = params.set('cursor', cursor);

    return this.http.get<CursorPage<OrderSummary>>(this.base, { params });
  }

  /**
   * 404 for an unknown order, another buyer's, or one the projection has not
   * yet attributed — the backend's §10.7 confirms none of the three, and a
   * read straight after placing can meet the last of them for as long as the
   * projection lags.
   */
  get(orderId: string): Observable<OrderDetail> {
    // encodeURIComponent for the reason OrderingApi.cancel() gives: the id
    // arrives from a route param Angular has already percent-decoded.
    return this.http.get<OrderDetail>(`${this.base}/${encodeURIComponent(orderId)}`);
  }
}
