import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of, throwError } from 'rxjs';
import { environment } from '@core/config/environment';
import { Address } from './types';

/**
 * Web.Bff/Endpoints/SavedAddressEndpoints.cs: the signed-in buyer's one saved
 * delivery address, through the gateway's /bff namespace. The subject is bound
 * from the principal on the server, so nothing here names a buyer.
 *
 * It lives in `core/` because Checkout reads it and Account shows it, and two
 * feature slices may not import each other.
 *
 * The address is personal data. Nothing here keeps it: no cache, nothing
 * written to Preferences beside the cart, and nothing logged (#93). Each
 * screen holds what it was handed for as long as it needs it and drops it when
 * nobody is signed in.
 */
@Injectable({ providedIn: 'root' })
export class SavedAddressApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.gatewayBaseUrl}/bff/v1/saved-address`;

  /**
   * The saved address, or `null` when this buyer has none. A buyer with
   * nothing saved is answered 404 and that is the ordinary first state, not a
   * failure: every other status still errors.
   */
  read(): Observable<Address | null> {
    return this.http
      .get<Address>(this.url)
      .pipe(
        catchError((failure: unknown) =>
          failure instanceof HttpErrorResponse && failure.status === 404
            ? of(null)
            : throwError(() => failure),
        ),
      );
  }

  /** Replaces the saved address, and answers with it as the server normalised it. */
  save(address: Address): Observable<Address> {
    return this.http.put<Address>(this.url, address);
  }

  /** Forgets it. The server answers 204 whether or not one was saved. */
  remove(): Observable<void> {
    return this.http.delete<void>(this.url);
  }
}
