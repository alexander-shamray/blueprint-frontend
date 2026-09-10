import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { QuoteResponse } from './types';

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

  /** Authenticated at the edge and again at the BFF's route group. */
  quote(productIds: readonly string[], currency: string): Observable<QuoteResponse> {
    let params = new HttpParams().set('currency', currency);

    for (const id of new Set(productIds)) params = params.append('productId', id);

    return this.http.get<QuoteResponse>(this.url, { params });
  }
}
