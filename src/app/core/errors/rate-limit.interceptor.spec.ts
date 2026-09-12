import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Signal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { environment } from '@core/config/environment';
import { RATE_LIMIT_FALLBACK_SECONDS } from './error-mapper';
import { RateLimitWindows } from './rate-limit';
import { rateLimitInterceptor } from './rate-limit.interceptor';

const GATEWAY = `${environment.gatewayBaseUrl.replace(/\/+$/, '')}/api/v1/products`;

const user: CurrentUser = {
  username: 'someone',
  subject: 'sub-1',
  permissions: [],
  expiresAt: Date.now() + 300_000,
};

class StubAuth {
  readonly current = signal<CurrentUser | null>(null);
  user = (): Signal<CurrentUser | null> => this.current;
  accessToken = () => (this.current() ? 'the-token' : null);
}

/**
 * Both interceptors, in the order `app.config.ts` registers them.
 *
 * That order is load-bearing rather than incidental: the partition the
 * gateway used is decided by whether the request carried a bearer, and only
 * `authInterceptor` knows that — it is the thing that attaches one. Running
 * this interceptor first would see every request as anonymous and file every
 * refusal in the wrong bucket, so the composition is what these tests
 * exercise, not `rateLimitInterceptor` on its own.
 */
describe('rateLimitInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let windows: RateLimitWindows;
  let auth: StubAuth;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor, rateLimitInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useClass: StubAuth },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    windows = TestBed.inject(RateLimitWindows);
    auth = TestBed.inject(AuthService) as unknown as StubAuth;
  });

  afterEach(() => {
    controller.verify();
    vi.useRealTimers();
  });

  const refuse = (url: string, headers: Record<string, string> = { 'Retry-After': '30' }) => {
    controller
      .expectOne(url)
      .flush(null, { status: 429, statusText: 'Too Many Requests', headers });
  };

  it('files a refusal of a request that carried a bearer under the authenticated window', () => {
    auth.current.set(user);
    http.get(GATEWAY).subscribe({ error: () => undefined });

    refuse(GATEWAY);

    expect(windows.authenticated.remaining()).toBe(30);
    expect(windows.anonymous.blocked()).toBe(false);
  });

  it('files a refusal of a request with no bearer under the anonymous window', () => {
    http.get(GATEWAY).subscribe({ error: () => undefined });

    refuse(GATEWAY);

    expect(windows.anonymous.remaining()).toBe(30);
    expect(windows.authenticated.blocked()).toBe(false);
  });

  it('falls back to a minute when the refusal carries no readable Retry-After', () => {
    // Same reasoning, and the same number, as the banner's: the parsing lives
    // in `mapError` and is not duplicated here, so a 429 the mapper cannot
    // read a delay from opens the window for the mapper's fallback rather
    // than for `NaN` seconds or a false-fact zero.
    http.get(GATEWAY).subscribe({ error: () => undefined });

    refuse(GATEWAY, {});

    expect(windows.anonymous.remaining()).toBe(RATE_LIMIT_FALLBACK_SECONDS);
  });

  it('closes the window when a later request in the same partition succeeds', () => {
    http.get(GATEWAY).subscribe({ error: () => undefined });
    refuse(GATEWAY);
    expect(windows.anonymous.blocked()).toBe(true);

    // The limiter rejects with 429 and nothing else, so ANY answer from
    // behind it is proof that this request was admitted — the bucket has
    // tokens, whatever the gateway predicted a moment ago.
    http.get(GATEWAY).subscribe();
    controller.expectOne(GATEWAY).flush([]);

    expect(windows.anonymous.blocked()).toBe(false);
  });

  it('closes the window on a failure that is not a refusal', () => {
    http.get(GATEWAY).subscribe({ error: () => undefined });
    refuse(GATEWAY);

    // A 503 came from behind the limiter too. The request was admitted; the
    // service failed it afterwards. That is a different banner, and not a
    // reason to keep the action disabled for the rest of the minute.
    http.get(GATEWAY).subscribe({ error: () => undefined });
    controller.expectOne(GATEWAY).flush(null, { status: 503, statusText: 'Service Unavailable' });

    expect(windows.anonymous.blocked()).toBe(false);
  });

  it('leaves the window alone when the request got no answer at all', () => {
    http.get(GATEWAY).subscribe({ error: () => undefined });
    refuse(GATEWAY);

    // Status 0: a network failure, a timeout, a CORS rejection. Nothing
    // reached the limiter, or nothing came back from it — either way the
    // client has learned nothing about the bucket, and closing the window on
    // no evidence would release the action early and straight into another
    // refusal.
    http.get(GATEWAY).subscribe({ error: () => undefined });
    controller.expectOne(GATEWAY).error(new ProgressEvent('error'));

    expect(windows.anonymous.blocked()).toBe(true);
  });

  it('files a signed-in refusal as anonymous when registered BEFORE authInterceptor', () => {
    // Not a configuration anyone should ship — it is the one `app.config.ts`
    // warns against, pinned here so the warning is executable rather than a
    // comment. Reversing the pair makes this interceptor read the request
    // before the bearer is on it, so a signed-in customer's refusal lands in
    // the IP bucket: their actions stay enabled against an empty bucket, and
    // a signed-out visitor's catalogue goes dead for a refusal that was never
    // theirs. Nothing throws, no test elsewhere notices, and the only symptom
    // is the original defect coming back wearing the fix's clothes.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([rateLimitInterceptor, authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useClass: StubAuth },
      ],
    });

    const reversedAuth = TestBed.inject(AuthService) as unknown as StubAuth;
    reversedAuth.current.set(user);
    const reversedWindows = TestBed.inject(RateLimitWindows);
    TestBed.inject(HttpClient).get(GATEWAY).subscribe({ error: () => undefined });

    TestBed.inject(HttpTestingController)
      .expectOne(GATEWAY)
      .flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } });

    expect(reversedWindows.anonymous.blocked()).toBe(true);
    expect(reversedWindows.authenticated.blocked()).toBe(false);

    TestBed.inject(HttpTestingController).verify();
  });

  it('ignores a refusal from a host that is not the gateway', () => {
    // Keycloak is the one here that matters: `WebAuthStrategy` delegates to
    // angular-oauth2-oidc, which uses this same HttpClient, so the token
    // endpoint's own rate limiting would otherwise disable Get quote and
    // Publish. Keycloak's limiter is not the gateway's bucket.
    const keycloak = 'https://identity.example.test/realms/commerce/protocol/openid-connect/token';
    http.get(keycloak).subscribe({ error: () => undefined });

    refuse(keycloak);

    expect(windows.anonymous.blocked()).toBe(false);
    expect(windows.authenticated.blocked()).toBe(false);
  });
});
