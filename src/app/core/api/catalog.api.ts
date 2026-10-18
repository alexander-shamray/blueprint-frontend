import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import {
  CursorPage, OwnProduct, ProductSummary, PublishProductCommand, WithdrawProductRequest,
} from './types';

/**
 * Catalog.Api/Endpoints/ProductEndpoints.cs, through the gateway. The gateway
 * strips /api before forwarding, so the service sees /v1/catalog/products —
 * the path here is the caller's, which is the one this file is responsible for.
 *
 * Knows HTTP and the wire types and nothing about screens (spec §3).
 */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.gatewayBaseUrl}/api/v1/catalog/products`;

  /**
   * Anonymous — the gateway's `catalog-public` route names YARP's reserved
   * `anonymous` policy and the endpoint itself says AllowAnonymous. This is
   * why the products tab works before sign-in (spec §5.1).
   */
  products(cursor: string | null, limit = 20): Observable<CursorPage<ProductSummary>> {
    let params = new HttpParams().set('limit', limit);
    if (cursor !== null) params = params.set('cursor', cursor);

    return this.http.get<CursorPage<ProductSummary>>(this.base, { params });
  }

  /**
   * One product, as the listing's row: `GetProduct` returns the same
   * `ProductSummaryDto`, and is anonymous on the same `catalog-public` route,
   * so a deep link works signed out. A withdrawn product is the same 404
   * `product.not_found` as an unknown id (`GetProductHandler.cs`, ADR-074).
   */
  product(id: string): Observable<ProductSummary> {
    return this.http.get<ProductSummary>(`${this.base}/${encodeURIComponent(id)}`);
  }

  /**
   * Requires `catalog:write`, and reaches Catalog through the gateway's
   * `catalog-write` route (Gateway.Api/appsettings.json) rather than
   * `catalog-public`. The two are deliberately separate: `catalog-public`
   * matches GET alone and is anonymous, `catalog-write` matches POST and
   * carries the `authenticated` policy. A single route doing both would
   * have made the listing's anonymity a property of a method check rather
   * than of the route, which is the weaker of the two places to put it.
   *
   * Replies 200 with the new id, not 201 — there is no Location header to
   * follow, and no endpoint to follow it to.
   */
  publish(command: PublishProductCommand): Observable<string> {
    return this.http.post<string>(this.base, command);
  }

  /**
   * The caller's own products, newest first, withdrawn ones included
   * (backend ADR-074). Behind `catalog:write` at the endpoint, and at the edge
   * the gateway's literal `catalog-own` route rather than `catalog-public`,
   * because this read names a caller: it is `authenticated` and draws on the
   * `authenticated` bucket, which `isPublicCatalogueRead` says. A cursor the
   * listing minted reads as the first page here, so the two never share one.
   */
  mine(cursor: string | null, limit = 20): Observable<CursorPage<OwnProduct>> {
    let params = new HttpParams().set('limit', limit);
    if (cursor !== null) params = params.set('cursor', cursor);

    return this.http.get<CursorPage<OwnProduct>>(`${this.base}/mine`, { params });
  }

  /**
   * Final: nothing undoes a withdrawal, and a second one, under any id, is the
   * 422 `product.withdrawn` (ADR-074). Another seller's product is the 404
   * `product.not_found`, never a 403, because a 403 would confirm it exists.
   * A POST, so `catalog-write` routes it; 204 on success, with no body.
   */
  withdraw(productId: string, request: WithdrawProductRequest): Observable<void> {
    return this.http.post<void>(
      `${this.base}/${encodeURIComponent(productId)}/withdrawal`,
      request,
    );
  }
}
