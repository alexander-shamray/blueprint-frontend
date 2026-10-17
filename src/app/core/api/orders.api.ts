import {
  HttpClient, HttpErrorResponse, HttpEventType, HttpHeaders, HttpParams,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defer, from, throwError } from 'rxjs';
import { environment } from '@core/config/environment';
import { OrderStreamEvent, readOrderEvents } from './order-events';
import { noSuchOrder, orderPathSegment } from './order-path';
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
    // One path segment or no request at all: `orderPathSegment` says why.
    const segment = orderPathSegment(orderId);
    if (segment === null) return noSuchOrder();

    return this.http.get<OrderDetail>(`${this.base}/${segment}`);
  }

  /**
   * ADR-108's stream over the same row: the detail route's answer first, then
   * each change, as `text/event-stream`. A 404 is answered before a stream
   * opens, with the three meanings `get` gives it.
   *
   * It is `HttpClient` and not `EventSource`, which cannot send the bearer —
   * and the token does not go in the query string. Going through `HttpClient`
   * keeps the auth and rate-limit interceptors on the request, and a download
   * progress event carries the text received so far, which `readOrderEvents`
   * cuts into events. Completes when the server ends the stream; unsubscribing
   * closes the connection.
   *
   * `lastEventId` is the id of the last event received, sent back as
   * `Last-Event-ID` so the server does not repeat a row the client holds.
   */
  stream(orderId: string, lastEventId: string | null = null): Observable<OrderStreamEvent> {
    const segment = orderPathSegment(orderId);
    if (segment === null) return noSuchOrder();

    let headers = new HttpHeaders({ Accept: 'text/event-stream' });
    if (lastEventId !== null) headers = headers.set('Last-Event-ID', lastEventId);

    return defer(() => {
      let consumed = 0;

      return this.http
        .get(`${this.base}/${segment}/events`, {
          headers,
          observe: 'events',
          reportProgress: true,
          responseType: 'text',
        })
        .pipe(
          concatMap((event) => {
            // The final response repeats the whole text; whatever progress
            // events already delivered is behind `consumed`.
            const text =
              event.type === HttpEventType.DownloadProgress
                ? event.partialText
                : event.type === HttpEventType.Response
                  ? event.body
                  : null;
            if (text == null) return EMPTY;

            const read = readOrderEvents(text, consumed);
            consumed = read.consumed;
            return from(read.events);
          }),
          catchError((failure: unknown) => throwError(() => asProblem(failure))),
        );
    });
  }
}

/**
 * A text response keeps an error's body as the string it arrived in, so the
 * problem details `mapError` reads would be lost; they are parsed back to the
 * object any other call's error carries.
 */
function asProblem(failure: unknown): unknown {
  if (!(failure instanceof HttpErrorResponse) || typeof failure.error !== 'string') return failure;

  try {
    const body: unknown = JSON.parse(failure.error);
    return new HttpErrorResponse({
      error: body,
      headers: failure.headers,
      status: failure.status,
      statusText: failure.statusText,
      url: failure.url ?? undefined,
    });
  } catch {
    return failure;
  }
}
