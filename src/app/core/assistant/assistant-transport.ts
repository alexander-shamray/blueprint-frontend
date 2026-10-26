import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpHeaders,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { environment } from '@core/config/environment';
import { mapError } from '@core/errors/error-mapper';
import { SERVICE_LIMITER } from '@core/errors/rate-limit.interceptor';
import { AssistantClient, EventSourceLike, Fetch, STREAM_CLOSED } from './assistant-client';
import { readSseFrames } from './sse';

/**
 * How the event stream reconnects. The BFF ends a stream inside its operation
 * timeout and asks for `retry: 1000` (`Web.Bff/Assistant/AssistantEndpoints.cs`
 * — `RetryAfter`), which is the wait after a stream that ended cleanly; one
 * that failed waits from `initialMs`, doubled per failure up to `maxMs`, and an
 * event received starts that over.
 */
export const ASSISTANT_STREAM = {
  initialMs: 1_000,
  maxMs: 15_000,
} as const;

/** EventSource's CONNECTING and OPEN. */
const CONNECTING = 0;
const OPEN = 1;

/**
 * Every assistant request says the BFF behind it limits on its own, so a
 * refusal of its making shuts no window of the gateway's (`SERVICE_LIMITER`).
 */
function assistantContext(): HttpContext {
  return new HttpContext().set(SERVICE_LIMITER, true);
}

/**
 * The assistant's two calls of the outside world, over `HttpClient`
 * (`docs/client-architecture.md` §19). `HttpClient` and not `fetch` and
 * `EventSource`, for the reason `OrdersApi.stream` gives: the BFF's
 * `/v1/assistant` group requires a bearer, EventSource cannot send one, the
 * token does not go in a query string, and going through `HttpClient` keeps
 * the auth, rate-limit and log interceptors on every request.
 */
@Injectable({ providedIn: 'root' })
export class AssistantTransport {
  private readonly http = inject(HttpClient);

  /** `Web.Bff/Assistant/AssistantEndpoints.cs` — `/v1/assistant`, through the gateway. */
  readonly base = `${environment.gatewayBaseUrl}/bff/v1/assistant`;

  client(): AssistantClient {
    return new AssistantClient(this.base, this.fetch, (url) => new HttpEventSource(this.http, url));
  }

  /**
   * `fetch`'s shape over `HttpClient`: an answer with a status is a
   * `Response` whatever the status, as `fetch` resolves one, and only a
   * request that reached nobody rejects. An aborted signal unsubscribes, which
   * cancels the request.
   */
  readonly fetch: Fetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const subscription = this.http
        .request(init?.method ?? 'GET', input, {
          body: typeof init?.body === 'string' ? init.body : null,
          headers: new HttpHeaders(headersOf(init)),
          context: assistantContext(),
          observe: 'response',
          responseType: 'text',
        })
        .subscribe({
          next: (response) => resolve(toResponse(response.status, response.body)),
          error: (error: unknown) => {
            if (error instanceof HttpErrorResponse && error.status !== 0) {
              resolve(
                toResponse(error.status, typeof error.error === 'string' ? error.error : null),
              );
            } else {
              reject(new TypeError('The request reached no host.'));
            }
          },
        });

      signal?.addEventListener(
        'abort',
        () => {
          subscription.unsubscribe();
          reject(signal.reason);
        },
        { once: true },
      );
    });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

/** A `Response` for a status: the null-body statuses take none, as `fetch` gives them none. */
function toResponse(status: number, body: string | null): Response {
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * An EventSource over `HttpClient`, as much of one as `AssistantClient`
 * reads: named events with ids, reconnection with `Last-Event-ID`, and
 * `CLOSED` once it gives up.
 *
 * It reconnects only on what a retry can mend: no answer at all, a 429 the
 * gateway or the BFF's limiter returned, a 5xx, or a stream the server ended
 * on its lifetime. Every other answer is not a stream, and it gives up on
 * those as a browser's does — a 404 for a conversation the host no longer
 * holds, a 401 or 403 for a caller it no longer admits, and any other 4xx.
 */
export class HttpEventSource implements EventSourceLike {
  readyState = CONNECTING;

  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  private subscription: Subscription | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = '';
  private retryMs: number = ASSISTANT_STREAM.initialMs;
  private failureMs = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
  ) {
    this.connect();
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = STREAM_CLOSED;
    this.subscription?.unsubscribe();
    this.subscription = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private connect(): void {
    this.timer = null;
    let headers = new HttpHeaders({ Accept: 'text/event-stream' });
    if (this.lastEventId !== '') headers = headers.set('Last-Event-ID', this.lastEventId);

    let consumed = 0;
    this.subscription = this.http
      .get(this.url, {
        headers,
        context: assistantContext(),
        observe: 'events',
        reportProgress: true,
        responseType: 'text',
      })
      .subscribe({
        next: (event: HttpEvent<string>) => {
          if (event.type === HttpEventType.ResponseHeader) this.readyState = OPEN;
          const text =
            event.type === HttpEventType.DownloadProgress
              ? (event as { partialText?: string }).partialText
              : event.type === HttpEventType.Response
                ? (event.body ?? undefined)
                : undefined;
          if (text === undefined) return;
          const read = readSseFrames(text, consumed);
          consumed = read.consumed;
          if (read.retry !== null) this.retryMs = read.retry;
          for (const frame of read.frames) this.dispatch(frame.event, frame.data, frame.id);
        },
        error: (error: unknown) => {
          const status = error instanceof HttpErrorResponse ? error.status : 0;
          // A 429 is waited out for as long as it says, never retried into:
          // `mapError` reads its Retry-After, and its fallback when it has none.
          const waitMs =
            status === 429 && error instanceof HttpErrorResponse
              ? (mapError(error).retryAfterSeconds ?? 0) * 1_000
              : 0;
          if (status === 0 || status === 429 || status >= 500) this.reconnect(true, waitMs);
          else this.giveUp();
        },
        complete: () => this.reconnect(false),
      });
  }

  private dispatch(name: string, data: string, id: string | null): void {
    if (this.readyState === STREAM_CLOSED) return;
    if (id !== null) this.lastEventId = id;
    this.failureMs = 0;
    const event = new MessageEvent(name, { data, lastEventId: this.lastEventId });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  private reconnect(failed: boolean, atLeastMs = 0): void {
    if (this.readyState === STREAM_CLOSED) return;
    this.readyState = CONNECTING;
    this.subscription = null;
    if (failed) {
      this.failureMs = Math.min(
        Math.max(this.failureMs * 2, ASSISTANT_STREAM.initialMs),
        ASSISTANT_STREAM.maxMs,
      );
      // A dropped connection fires EventSource's own `error`, with no data.
      this.fireError();
    }
    const delay = failed ? Math.max(this.failureMs, atLeastMs) : this.retryMs;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private giveUp(): void {
    this.close();
    this.fireError();
  }

  private fireError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener(new Event('error') as MessageEvent);
    }
  }
}
