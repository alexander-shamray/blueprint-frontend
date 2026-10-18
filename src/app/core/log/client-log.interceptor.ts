import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { isGatewayUrl } from '@core/config/gateway-url';
import { mapError } from '@core/errors/error-mapper';
import { ClientLog, pathOf } from './client-log';

/**
 * Records every command's outcome and every failure, at the one place every
 * request to the gateway passes (#93). A request outside the gateway is not
 * recorded at all, and two kinds pass through this `HttpClient`: the
 * identity provider's discovery and token calls, which angular-oauth2-oidc
 * makes through it (`gateway-url.ts`), and the object store's pre-signed
 * `PUT` (`client-architecture.md` §11), whose query string is its signature.
 *
 * A command is a request whose body carries a `commandId`
 * (`client-architecture.md` §4), and the id is
 * all that is read from the body. Its outcome is `accepted` or the error
 * mapper's kind, so a 409 reads as `alreadyCommitted` or `idReused` exactly as
 * the page that sent it reads it. A failure of anything else records the
 * mapped kind and the status. Both carry the correlation id `mapError` takes
 * from the ProblemDetails body, which is the reference the banner shows.
 */
export const clientLogInterceptor: HttpInterceptorFn = (request, next) => {
  if (!isGatewayUrl(request.url)) return next(request);

  const log = inject(ClientLog);
  const path = pathOf(request.url);
  const commandId = commandIdOf(request.body);

  return next(request).pipe(
    tap({
      next: (event) => {
        if (!(event instanceof HttpResponse) || commandId === null) return;
        log.record({
          kind: 'command',
          method: request.method,
          path,
          commandId,
          outcome: 'accepted',
          status: event.status,
        });
      },
      error: (error: unknown) => {
        if (!(error instanceof HttpErrorResponse)) return;
        const mapped = mapError(error);
        const correlationId = mapped.correlationId;
        if (commandId !== null) {
          log.record({
            kind: 'command',
            method: request.method,
            path,
            commandId,
            outcome: mapped.kind,
            status: error.status,
            ...(correlationId === undefined ? {} : { correlationId }),
          });
        } else {
          log.record({
            kind: 'failure',
            method: request.method,
            path,
            status: error.status,
            errorKind: mapped.kind,
            ...(correlationId === undefined ? {} : { correlationId }),
          });
        }
      },
    }),
  );
};

/** The body's `commandId` when it is a string, and nothing else from it. */
function commandIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('commandId' in body)) return null;
  return typeof body.commandId === 'string' ? body.commandId : null;
}
