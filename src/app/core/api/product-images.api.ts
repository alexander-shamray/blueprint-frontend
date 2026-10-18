import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { ProductImageUpload, ProductImageUploadRequest } from './types';

/**
 * Backend E.6.11, the product image upload, in its two hops. The first is the
 * BFF's, through the gateway's `web-bff` route; the second goes to the object
 * store the BFF signed for, which is a second host and the exception
 * `client-architecture.md` §11 argues.
 *
 * Knows HTTP and the wire types and nothing about screens (spec §3).
 */
@Injectable({ providedIn: 'root' })
export class ProductImagesApi {
  private readonly http = inject(HttpClient);

  /**
   * `POST /bff/v1/product-images`, behind `catalog:write`. Writes nothing:
   * each call draws a new key and signs a new URL, so it carries no command id
   * and a repeat is harmless (`RetrySafe(ReadOnly)` on the endpoint).
   */
  issue(request: ProductImageUploadRequest): Observable<ProductImageUpload> {
    return this.http.post<ProductImageUpload>(
      `${environment.gatewayBaseUrl}/bff/v1/product-images`,
      request,
    );
  }

  /**
   * The bytes, straight to the store. Only `Content-Type` is set from the
   * signed headers: `Content-Length` is a header the browser forbids a script
   * to set, and it sends the file's own length, which is the size `issue` was
   * told. Neither interceptor touches this request, because its URL is not the
   * gateway's: no bearer goes to the store, and its refusals are not the
   * gateway limiter's to count.
   */
  upload(upload: ProductImageUpload, file: Blob): Observable<void> {
    const contentType = upload.headers['Content-Type'] ?? file.type;
    return this.http.put<void>(upload.uploadUrl, file, {
      headers: new HttpHeaders({ 'Content-Type': contentType }),
    });
  }
}
