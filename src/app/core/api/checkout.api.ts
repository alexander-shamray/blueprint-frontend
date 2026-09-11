import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { QuoteRequest, QuoteRequestLine, QuoteResponse } from './types';

/**
 * Web.Bff/Endpoints/CheckoutEndpoints.cs, through the gateway's second
 * namespace. /bff rather than /api because a client picks one or the other:
 * aggregated responses shaped for a screen, or the service APIs shaped for a
 * resource. The gateway strips /bff exactly as it strips /api.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.gatewayBaseUrl}/bff/v1/checkout/quote`;

  /**
   * Authenticated at the edge and again at the BFF's route group.
   *
   * POST with a body of quantified lines, which is what the endpoint is
   * (ADR-045). The lines go over as they are given: a product named twice is
   * merged by the BFF, exactly as `Order.AddLine` merges it one service over,
   * and a client that deduplicated them first would send a basket smaller than
   * the customer's. The `new Set(productIds)` that used to stand here was
   * right under the old contract, where a repeated id carried nothing, and
   * would silently discard a quantity under this one.
   */
  quote(lines: readonly QuoteRequestLine[], currency: string): Observable<QuoteResponse> {
    const request: QuoteRequest = { currency, lines };

    return this.http.post<QuoteResponse>(this.url, request);
  }
}
