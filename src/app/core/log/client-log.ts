import { Injectable } from '@angular/core';
import { ErrorKind } from '@core/errors/error-mapper';

/**
 * What the client records about itself, and nothing else (#93). Each member
 * is a fact the client already holds at one of its seams, and none carries
 * a value somebody typed or a credential:
 *
 * - a `path` is a URL's path alone. A query string can carry the
 *   authorization `code` and `state` on the OAuth return, and a fragment can
 *   carry a token, so neither is ever kept;
 * - a request's body is read for its `commandId` and for nothing else, so an
 *   address, a name or a price never reaches a log;
 * - no header is read, so the bearer token cannot be.
 *
 * The correlation id is the point: it is the reference the error banner
 * shows, and with it a failure can be found in the backend's own logs after
 * the banner has gone.
 */
export type ClientLogEvent =
  | { readonly kind: 'navigation'; readonly path: string }
  | {
      readonly kind: 'command';
      readonly method: string;
      readonly path: string;
      readonly commandId: string;
      /** `accepted` for a 2xx, otherwise the error mapper's kind for the refusal. */
      readonly outcome: 'accepted' | ErrorKind;
      readonly status: number;
      readonly correlationId?: string;
    }
  | {
      readonly kind: 'failure';
      readonly method: string;
      readonly path: string;
      readonly status: number;
      readonly errorKind: ErrorKind;
      readonly correlationId?: string;
    };

/**
 * The seam where a vendor adapter or OpenTelemetry-web goes later. One
 * adapter today, the console, and no network: choosing a vendor is not this
 * port's decision.
 *
 * An abstract class rather than an InjectionToken, as `AuthService` is, so
 * the default adapter can be the class's own `useFactory`.
 */
@Injectable({ providedIn: 'root', useFactory: () => new ConsoleClientLog() })
export abstract class ClientLog {
  abstract record(event: ClientLogEvent): void;
}

/**
 * Writes each event to the browser console at `info`, under one prefix a
 * reader can filter on. The unit suite never sees it: it is reached only
 * through the interceptor and the navigation recorder, which only
 * `app.config.ts` provides, and no spec but their own configures either.
 */
export class ConsoleClientLog extends ClientLog {
  record(event: ClientLogEvent): void {
    console.info('[client-log]', event);
  }
}

/** A URL's path, without its query or fragment, whether absolute or relative. */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  const scheme = bare.indexOf('://');
  if (scheme === -1) return bare === '' ? '/' : bare;
  const slash = bare.indexOf('/', scheme + 3);
  return slash === -1 ? '/' : bare.slice(slash);
}
