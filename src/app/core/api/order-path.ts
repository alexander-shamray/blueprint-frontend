import { HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';

/**
 * An order id as one path segment, or null when it cannot be one.
 *
 * The id reaches the two order calls from a route param, which Angular has
 * already percent-decoded, so `encodeURIComponent` is what keeps a '/', '?' or
 * '%' in it from turning into a different path plus a query string. It leaves
 * '.' and '..' alone, though, and the URL parser resolves those as path
 * segments: `/tabs/orders/%2E%2E` would make the read `GET /bff/v1/orders/..`,
 * which is `/bff/v1/` with the bearer attached. An empty id is the list route
 * by another name. None of the three is an order, so none is sent.
 */
export function orderPathSegment(orderId: string): string | null {
  if (orderId === '' || orderId === '.' || orderId === '..') return null;
  return encodeURIComponent(orderId);
}

/**
 * What a refused id answers instead of a request: the 404 the platform gives
 * an order it will not show, so every caller's existing handling applies — the
 * detail's banner, and Order placed's "not recorded yet" note.
 */
export function noSuchOrder<T>(): Observable<T> {
  return throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));
}
