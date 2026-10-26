import {
  HttpContextToken,
  HttpErrorResponse,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { isGatewayUrl, isPublicCatalogueRead } from '@core/config/gateway-url';
import { mapError } from './error-mapper';
import { RateLimitWindows } from './rate-limit';

/**
 * Set on a request whose service behind the gateway runs a limiter of its own,
 * which answers 429 with no `Retry-After`: the BFF's `assistant-start` policy
 * and its "Too many conversations" refusal
 * (`Web.Bff/Assistant/DependencyInjection.cs`, `AssistantEndpoints.cs`). The
 * gateway's own 429 always carries the header (`docs/client-architecture.md`
 * §10), so on such a request a 429 without it is the service's, not a bucket
 * this client keeps a window for, and it opens none. It reached the service,
 * so the gateway admitted it, and it closes the window as an answer does.
 *
 * The residual: §10 names the cases where the gateway's own 429 reaches this
 * client with no readable header (an intermediary that strips it, CORS off, a
 * gateway older than `27b54a7`). On a marked request that refusal is taken
 * for the service's and opens no window, where an unmarked one would open
 * the fallback minute; the next unmarked request the bucket refuses opens it.
 */
export const SERVICE_LIMITER = new HttpContextToken<boolean>(() => false);

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

        if (
          error.status === 429 &&
          request.context.get(SERVICE_LIMITER) &&
          !error.headers.has('Retry-After')
        ) {
          window.close(epoch);
          return;
        }

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
