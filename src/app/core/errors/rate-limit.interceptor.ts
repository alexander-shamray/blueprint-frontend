import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { isGatewayUrl, isPublicCatalogueRead } from '@core/config/gateway-url';
import { mapError } from './error-mapper';
import { RateLimitWindows } from './rate-limit';

/**
 * Opens and closes the rate-limit windows from what the gateway actually
 * answered.
 *
 * An interceptor rather than a report from each page, and that is forced
 * rather than tidy: a refusal provoked by one page has to disable the actions
 * on every other page drawing on the same bucket, which is the entire defect.
 * A page reporting its own errors can only ever silence itself.
 *
 * The partition comes from the route (`isPublicCatalogueRead`), which is how
 * the gateway picks its policy — so this interceptor reads nothing off the
 * request that another interceptor has to have written first, and its
 * position in the chain does not matter.
 */
export const rateLimitInterceptor: HttpInterceptorFn = (request, next) => {
  if (!isGatewayUrl(request.url)) return next(request);

  const window = inject(RateLimitWindows).forPartition(
    isPublicCatalogueRead(request.method, request.url) ? 'catalogue' : 'authenticated',
  );

  // Read BEFORE the request goes out, so a response that lands after some
  // other request was refused cannot close a window it never saw.
  const epoch = window.epoch;

  return next(request).pipe(
    tap({
      next: (event) => {
        // A response means the limiter admitted this request — it either
        // rejects with 429 or lets the request through, and an admission
        // granted out of the authenticated policy's queue is one granted at
        // replenishment, when the bucket has just refilled. Either way the
        // gateway's earlier prediction has been overtaken by an answer, and
        // holding the action dead for the rest of the window would be this
        // client enforcing a limit the gateway is not.
        if (event instanceof HttpResponse) window.close(epoch);
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
        else window.close(epoch);
      },
    }),
  );
};
