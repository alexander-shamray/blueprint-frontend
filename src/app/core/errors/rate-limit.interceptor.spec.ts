import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { environment } from '@core/config/environment';
import { RATE_LIMIT_FALLBACK_SECONDS } from './error-mapper';
import { RateLimitWindows } from './rate-limit';
import { rateLimitInterceptor } from './rate-limit.interceptor';

const BASE = environment.gatewayBaseUrl.replace(/\/+$/, '');

/**
 * The four gateway URLs this client actually builds, which between them cover
 * both of the gateway's limiter policies — and cover the pair that makes the
 * route rule non-obvious: `catalog.api.ts` builds ONE base for the listing and
 * the publish, so `LISTING` and `PUBLISH` are the same URL under two methods,
 * limited by two different buckets.
 */
const LISTING = `${BASE}/api/v1/catalog/products`;
const PUBLISH = `${BASE}/api/v1/catalog/products`;
const QUOTE = `${BASE}/bff/v1/checkout/quote`;
const ORDERS = `${BASE}/api/v1/orders`;

describe('rateLimitInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let windows: RateLimitWindows;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([rateLimitInterceptor])),
        provideHttpClientTesting(),
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    windows = TestBed.inject(RateLimitWindows);
  });

  afterEach(() => {
    controller.verify();
    vi.useRealTimers();
  });

  const refuse = (
    match: Parameters<HttpTestingController['expectOne']>[0],
    headers: Record<string, string> = { 'Retry-After': '30' },
  ) => {
    controller
      .expectOne(match)
      .flush(null, { status: 429, statusText: 'Too Many Requests', headers });
  };

  it('files a refused catalogue listing under the catalogue window', () => {
    // `GET /api/v1/catalog/**` is the ONE route the gateway gives its
    // `anonymous` policy — a fixed window of 100 a minute per IP — and it
    // does so whether or not the caller is signed in.
    http.get(LISTING).subscribe({ error: () => undefined });

    refuse((r) => r.url === LISTING && r.method === 'GET');

    expect(windows.catalogue.remaining()).toBe(30);
    expect(windows.authenticated.blocked()).toBe(false);
  });

  it('files a refused publish under the authenticated window, at the same URL', () => {
    // The test that would have caught the bearer-based rule this replaced:
    // same path, same host, different method, different bucket. YARP's
    // `catalog-write` route matches POST and names the authenticated policy.
    http.post(PUBLISH, {}).subscribe({ error: () => undefined });

    refuse((r) => r.url === PUBLISH && r.method === 'POST');

    expect(windows.authenticated.remaining()).toBe(30);
    expect(windows.catalogue.blocked()).toBe(false);
  });

  it('files a refused quote under the authenticated window', () => {
    http.post(QUOTE, {}).subscribe({ error: () => undefined });

    refuse(QUOTE);

    expect(windows.authenticated.remaining()).toBe(30);
    expect(windows.catalogue.blocked()).toBe(false);
  });

  it('files a refused order under the authenticated window', () => {
    http.post(ORDERS, {}).subscribe({ error: () => undefined });

    refuse(ORDERS);

    expect(windows.authenticated.remaining()).toBe(30);
    expect(windows.catalogue.blocked()).toBe(false);
  });

  it('falls back to a minute when the refusal carries no readable Retry-After', () => {
    // Same reasoning, and the same number, as the banner's: the parsing lives
    // in `mapError` and is not duplicated here, so a 429 the mapper cannot
    // read a delay from opens the window for the mapper's fallback rather
    // than for `NaN` seconds or a false-fact zero.
    http.get(LISTING).subscribe({ error: () => undefined });

    refuse((r) => r.url === LISTING, {});

    expect(windows.catalogue.remaining()).toBe(RATE_LIMIT_FALLBACK_SECONDS);
  });

  it('closes the window when a later request in the same partition succeeds', () => {
    http.get(LISTING).subscribe({ error: () => undefined });
    refuse((r) => r.url === LISTING);
    expect(windows.catalogue.blocked()).toBe(true);

    // The limiter admits or rejects, and an admission out of the queue is one
    // granted at replenishment — so an answer of any kind means the bucket
    // has tokens now, whatever the gateway predicted a moment ago.
    http.get(LISTING).subscribe();
    controller.expectOne(LISTING).flush([]);

    expect(windows.catalogue.blocked()).toBe(false);
  });

  it('closes the window on a failure that is not a refusal', () => {
    http.get(LISTING).subscribe({ error: () => undefined });
    refuse((r) => r.url === LISTING);

    // A 503 came from behind the limiter too. The request was admitted; the
    // service failed it afterwards. That is a different banner, and not a
    // reason to keep the action disabled for the rest of the minute.
    http.get(LISTING).subscribe({ error: () => undefined });
    controller.expectOne(LISTING).flush(null, { status: 503, statusText: 'Service Unavailable' });

    expect(windows.catalogue.blocked()).toBe(false);
  });

  it('leaves the window alone when the request got no answer at all', () => {
    http.get(LISTING).subscribe({ error: () => undefined });
    refuse((r) => r.url === LISTING);

    // Status 0: a network failure, a timeout, a CORS rejection. Nothing
    // reached the limiter, or nothing came back from it — either way the
    // client has learned nothing about the bucket, and closing the window on
    // no evidence would release the action early and straight into another
    // refusal.
    http.get(LISTING).subscribe({ error: () => undefined });
    controller.expectOne(LISTING).error(new ProgressEvent('error'));

    expect(windows.catalogue.blocked()).toBe(true);
  });

  it('does not let a success that was already in flight close a newer refusal', () => {
    // Two requests overlap. The first is admitted, the second is refused and
    // opens the window, and only then does the first one's 200 arrive. It is
    // evidence about the bucket as it was BEFORE the refusal, so it must not
    // cancel a wait the platform has since asked for.
    http.get(LISTING).subscribe();
    http.get(LISTING).subscribe({ error: () => undefined });

    const [first, second] = controller.match(LISTING);
    second.flush(null, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '30' },
    });
    first.flush([]);

    expect(windows.catalogue.blocked()).toBe(true);
    expect(windows.catalogue.remaining()).toBe(30);
  });

  it('ignores a refusal from a host that is not the gateway', () => {
    // Keycloak is the one here that matters: `WebAuthStrategy` delegates to
    // angular-oauth2-oidc, which uses this same HttpClient, so the token
    // endpoint's own rate limiting would otherwise disable Get quote and
    // Publish. Keycloak's limiter is not the gateway's bucket.
    const keycloak = 'https://identity.example.test/realms/commerce/protocol/openid-connect/token';
    http.get(keycloak).subscribe({ error: () => undefined });

    refuse(keycloak);

    expect(windows.catalogue.blocked()).toBe(false);
    expect(windows.authenticated.blocked()).toBe(false);
  });
});
