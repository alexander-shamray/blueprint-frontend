import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { isGatewayUrl } from '@core/config/gateway-url';
import { mapError } from './error-mapper';
import { RateLimitWindows } from './rate-limit';

/**
 * Opens and closes the rate-limit windows from what the gateway actually
 * answered.
 *
 * An interceptor rather than a report from each page, and that is forced
 * rather than tidy: the gateway partitions its limiter by whether a request
 * carried a bearer, and a page does not know that about its own request —
 * `authInterceptor` attaches the token, and the catalogue is anonymous or
 * authenticated depending only on whether anyone is signed in. Here the
 * request is in hand and the question answers itself.
 *
 * It also means every refusal counts, including ones from a page the
 * customer is not looking at, which is the whole defect: a 429 raised by Get
 * quote used to leave Publish and the catalogue enabled against a bucket that
 * was already empty.
 *
 * MUST be registered after `authInterceptor` (see `app.config.ts`). It reads
 * the `Authorization` header off the request it is handed, so running first
 * would see every request as anonymous.
 */
export const rateLimitInterceptor: HttpInterceptorFn = (request, next) => {
  if (!isGatewayUrl(request.url)) return next(request);

  const window = inject(RateLimitWindows).forRequest(request.headers.has('Authorization'));

  return next(request).pipe(
    tap({
      next: (event) => {
        // A response of any status came from BEHIND the limiter — it rejects
        // with 429 and nothing else — so the bucket has tokens whatever it
        // predicted a moment ago, and holding the action dead for the rest of
        // the window would be this client enforcing a limit the gateway is
        // not.
        if (event instanceof HttpResponse) window.close();
      },
      error: (error: unknown) => {
        if (!(error instanceof HttpErrorResponse)) return;

        // Status 0 is a network failure, a timeout or a CORS rejection:
        // nothing reached the limiter, or nothing came back from it. The
        // client has learned nothing about the bucket either way, and
        // closing an open window on no evidence releases the action early
        // and straight into another refusal.
        if (error.status === 0) return;

        // `mapError` owns the Retry-After parsing — the header can be absent,
        // empty, whitespace-only or an HTTP-date, and the fallback for all of
        // those is decided once, in one place, with the reasoning written
        // there. Duplicating the parse here is how the banner and the
        // countdown come to disagree about how long the wait is.
        const mapped = mapError(error);
        if (mapped.kind === 'rateLimited') window.open(mapped);
        else window.close();
      },
    }),
  );
};
