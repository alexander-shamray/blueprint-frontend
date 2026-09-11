import { HttpErrorResponse } from '@angular/common/http';
import { ProblemDetails, isProblemDetails } from './problem-details';

/**
 * The six generic banners spec §6 permits the client to author, plus the two
 * extra 409 kinds the backend actually distinguishes. Everything else on
 * screen is the backend's own `title` and `detail`, shown as sent.
 */
export type ErrorKind =
  | 'validation'
  | 'banner'
  | 'signIn'
  | 'forbidden'
  | 'alreadyCommitted'
  | 'inProgress'
  | 'concurrencyConflict'
  | 'rule'
  | 'rateLimited'
  | 'unavailable'
  | 'retry';

export interface DisplayError {
  readonly kind: ErrorKind;
  readonly title: string;
  readonly detail: string | null;
  /** 400 only, keyed exactly as the backend keyed it. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly retryAfterSeconds?: number;
  /**
   * True when the countdown is this client's guess rather than the gateway's
   * number. The banner says so: a countdown presented as fact when it is a
   * fallback is a lie the user cannot detect.
   */
  readonly retryAfterIsFallback?: boolean;
  readonly correlationId?: string;
  /** 403 only. Taken from the route's metadata, never from the response. */
  readonly permission?: string;
}

/**
 * Used when a 429 arrives with no readable `Retry-After`.
 *
 * The gateway exposes the header across origins — Gateway.Api/Program.cs
 * calls `WithExposedHeaders("Retry-After", ...)` — so CORS on that gateway is
 * not the reason a browser cannot read it, and neither is the limiter: both
 * of the gateway's policies (a fixed window and a token bucket) leave
 * `QueueProcessingOrder` at its default `OldestFirst`, and every rejection
 * those two can produce carries `MetadataName.RetryAfter`. A metadata-less
 * lease needs `NewestFirst`, which neither policy sets.
 *
 * What is left is everything between that gateway and this `switch`: a header
 * that arrives empty, whitespace-only, non-numeric or in HTTP's date form; an
 * intermediary that strips it; a deployment with `Cors__Enabled` off, where
 * the header is sent and the browser is not allowed to read it; and a gateway
 * older than the commit that added the exposure. Those are the five cases the
 * 429 branch below handles and `error-mapper.spec.ts` pins one by one —
 * unreadable is a fact about the response, and the client answers it the same
 * way regardless of which of them produced it. `retryAfterIsFallback` tells
 * the banner to say the number is this client's own estimate rather than the
 * platform's.
 *
 * The limiter's real budget is 300 tokens per minute, so a minute is the
 * honest round number to wait rather than a tuned guess.
 */
export const RATE_LIMIT_FALLBACK_SECONDS = 60;

/** Backend codes on the 409 row. Common.Web's three handlers, verbatim. */
const CONFLICT_KINDS: Readonly<Record<string, ErrorKind>> = {
  'request.in_progress': 'inProgress',
  'command.already_committed': 'alreadyCommitted',
  'request.concurrency_conflict': 'concurrencyConflict',
};

export function mapError(
  error: unknown,
  context?: { readonly permission?: string },
): DisplayError {
  if (!(error instanceof HttpErrorResponse)) {
    // angular-oauth2-oidc's loadDiscoveryDocument() — and therefore
    // WebAuthStrategy.signIn(), which awaits it — can reject with a bare
    // string rather than an Error, let alone an HttpErrorResponse: there is
    // no HTTP response here to read a status or a body from. Every call site
    // before cart.page.ts's sign-in retry was an HttpClient error handler,
    // where `HttpErrorResponse` was actually true; that caller breaks the
    // assumption, so the parameter widens to `unknown` and this branch is
    // what keeps it from a runtime TypeError reading `.status` off a string.
    return { kind: 'retry', title: '', detail: null };
  }

  const body: ProblemDetails = isProblemDetails(error.error) ? error.error : {};
  const title = body.title ?? '';
  const detail = body.detail ?? null;
  const correlationId = body.correlationId;

  const base = { title, detail, correlationId } as const;

  switch (error.status) {
    case 400:
      return body.errors
        ? { ...base, kind: 'validation', fields: body.errors }
        : { ...base, kind: 'banner' };

    case 401:
      // The caller invokes AuthService.signIn() and replays. Nothing is
      // decided here, because only the caller knows what to replay.
      return { ...base, kind: 'signIn' };

    case 403:
      // The permission comes from the route's own metadata. A hidden button
      // and a refused call are two different facts (spec §4.3), and the
      // response deliberately does not name a permission — echoing one would
      // be the backend describing its own policy to an unauthorised caller.
      return { ...base, kind: 'forbidden', permission: context?.permission };

    case 404:
      return { ...base, kind: 'banner' };

    case 409:
      // Switching on `code`, not on `detail`. The three producers carry
      // instructions that contradict each other — one says retry, one says do
      // not — and RFC 9457 makes `detail` human-readable, so a client told
      // them apart by English would break on a reword. An absent code takes
      // the kind that forbids the retry: guessing "retry" on a command that
      // already committed is the one wrong answer that places a second order.
      return {
        ...base,
        kind: (body.code && CONFLICT_KINDS[body.code]) || 'alreadyCommitted',
      };

    case 422:
      return { ...base, kind: 'rule' };

    case 429: {
      // `header` can be missing, empty, whitespace-only, or non-numeric (HTTP
      // allows an HTTP-date form of Retry-After; the gateway only ever sends
      // seconds, so a date is out of contract here and — like every other
      // unreadable value — must fall back rather than be trusted as `NaN`
      // seconds or, worse, `Number('')` coercing to a false-fact zero).
      const header = error.headers?.get('Retry-After');
      const trimmed = header?.trim();
      const parsed = trimmed ? Number(trimmed) : Number.NaN;
      const readable = Number.isFinite(parsed) && parsed >= 0;

      return {
        ...base,
        kind: 'rateLimited',
        retryAfterSeconds: readable ? parsed : RATE_LIMIT_FALLBACK_SECONDS,
        retryAfterIsFallback: !readable,
      };
    }

    case 503:
      return { ...base, kind: 'unavailable' };

    default:
      // Every other 5xx, plus status 0 — a network failure, a timeout, a CORS
      // rejection. There is no body on those, so there is no correlation id to
      // carry, and `base` already reflects that.
      return { ...base, kind: 'retry' };
  }
}
