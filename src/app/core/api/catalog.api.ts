import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { CursorPage, ProductSummary, PublishProductCommand } from './types';

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
   * Requires `catalog:write`, and requires the gateway's `catalog-write` route
   * (plan Task 0): `catalog-public` matches GET alone, so before that route
   * exists this call 404s at the edge rather than reaching Catalog at all.
   *
   * Replies 200 with the new id, not 201 — there is no Location header to
   * follow, and no endpoint to follow it to.
   */
  publish(command: PublishProductCommand): Observable<string> {
    return this.http.post<string>(this.base, command);
  }
}
