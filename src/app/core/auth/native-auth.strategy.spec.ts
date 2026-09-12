import { webcrypto } from 'node:crypto';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { environment } from '@core/config/environment';
import {
  NativeAuthStrategy,
  REFRESH_TOKEN_KEY,
  SECURE_STORAGE,
  SYSTEM_BROWSER,
  URL_OPEN_EVENTS,
} from './native-auth.strategy';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

/** A token that expires five minutes from the frozen clock, as the realm's does. */
function fiveMinuteToken(): string {
  return jwt({
    preferred_username: 'demo',
    sub: 's',
    permission: ['orders:write'],
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

function tokenResponse(refresh: string) {
  return {
    ok: true,
    json: async () => ({ access_token: fiveMinuteToken(), refresh_token: refresh }),
  };
}

describe('NativeAuthStrategy', () => {
  const store = new Map<string, string>();
  const secure = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    remove: vi.fn(async (k: string) => void store.delete(k)),
  };
  // Typed through the generic rather than through the implementation's
  // parameters, so `mock.calls[0][0]` has a type and the unused-parameter
  // rule has nothing to object to.
  const browser = {
    /** Set by onFinished; a test calls it to dismiss the browser. */
    finished: null as (() => void) | null,
    open: vi.fn<(options: { url: string }) => Promise<void>>(async () => undefined),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    onFinished: vi.fn(async (h: () => void) => {
      browser.finished = h;
    }),
  };
  /** Stands in for @capacitor/app's appUrlOpen, so a test can deliver the return itself. */
  const urlOpen = {
    handler: null as ((url: string) => void) | null,
    onUrlOpen: vi.fn(async (h: (url: string) => void) => {
      urlOpen.handler = h;
    }),
  };
  let strategy: NativeAuthStrategy;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    urlOpen.handler = null;
    browser.finished = null;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom's Crypto implements getRandomValues and randomUUID and nothing
    // else — it has no `subtle` at all (jsdom/lib/jsdom/living/crypto/
    // Crypto-impl.js). Node's WebCrypto does, so the S256 challenge these
    // tests assert is a real SHA-256 rather than a stand-in. Production has
    // it for the reason the strategy's own comment gives: both platforms
    // serve the bundle from a secure context.
    vi.stubGlobal('crypto', webcrypto);
    // A five-minute token schedules a renewal under four minutes out. Without
    // a fake clock that timer is real, and it would fire against a torn-down
    // environment after the suite finishes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));

    TestBed.configureTestingModule({
      providers: [
        NativeAuthStrategy,
        { provide: SECURE_STORAGE, useValue: secure },
        { provide: SYSTEM_BROWSER, useValue: browser },
        { provide: URL_OPEN_EVENTS, useValue: urlOpen },
      ],
    });

    strategy = TestBed.inject(NativeAuthStrategy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * Starts a sign-in and returns its promise WITHOUT awaiting it: since #3 the
   * promise settles when the flow completes, not when the browser opens, so
   * awaiting `signIn()` here would wait for a callback the test has not sent
   * yet. `signIn` awaits the S256 digest before opening the browser, which is
   * more than one microtask deep, so spin a bounded number of them rather
   * than guessing a count.
   */
  async function startSignIn(): Promise<{ flow: Promise<void> }> {
    const flow = strategy.signIn();
    // `vi.waitFor`, not a microtask spin: `signIn` awaits the SHA-256 digest
    // first, and Node's WebCrypto runs that on the libuv threadpool, so it
    // settles on a macrotask that draining microtasks never reaches. waitFor
    // advances the fake clock, which does.
    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
    // Wrapped in an object, not returned bare: `await` flattens a promise of
    // a promise, so returning `flow` from an async function would await the
    // sign-in itself — the very thing these tests must not do yet.
    return { flow };
  }

  /** Delivers the return leg with the pending state, as the OS would. */
  function deliverCallback(code = 'abc'): Promise<void> {
    return strategy.handleCallback(
      `blueprint://auth/callback?code=${code}&state=${strategy.pendingState()}`,
    );
  }

  it('opens the SYSTEM browser, never a web view', async () => {
    void startSignIn();
    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());

    const url = browser.open.mock.calls[0][0].url;
    // Derived, not literal: the unit-test target declares no
    // `fileReplacements` (angular.json), so a spec loads the PRODUCTION
    // environment.ts. Pinning a literal host here would pin which config
    // file the harness happens to load, which is not a property of this
    // class. That the authorize URL is built from the configured issuer IS.
    expect(url.startsWith(`${environment.auth.issuer}/protocol/openid-connect/auth?`)).toBe(true);
    // These three stay literal, because both environment files agree on them
    // and each pins a choice between two configured values that differ:
    // nativeClientId over webClientId ('web-app'), nativeRedirectUri over
    // redirectUri, and S256 over 'plain'.
    expect(url).toContain('client_id=mobile-app');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain(encodeURIComponent('blueprint://auth/callback'));
  });

  it('keeps the access token in memory and the refresh token in secure storage', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));

    const { flow } = await startSignIn();
    await deliverCallback();
    await flow;

    expect(strategy.accessToken()).not.toBeNull();
    expect(strategy.user()()?.username).toBe('demo');
    // The exchange must carry the verifier: a public client with PKCE
    // required is refused without it, which is the failure the web
    // strategy's HybridOAuthStorage exists to prevent on its own platform.
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('code_verifier=');
    // Secure storage, not Preferences: the refresh token is a credential.
    expect(secure.set).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, 'refresh-1');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('refuses a callback whose state does not match the pending one', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));

    void startSignIn();
    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
    await strategy.handleCallback('blueprint://auth/callback?code=abc&state=not-the-pending-state');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(strategy.accessToken()).toBeNull();
    // The pending flow is untouched, so the legitimate return still works.
    expect(strategy.pendingState()).not.toBeNull();
  });

  it('does not resolve until the user has actually signed in (#3)', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));
    const { flow } = await startSignIn();

    let settled = false;
    void flow.then(
      () => (settled = true),
      () => (settled = true),
    );

    // Everything that is not the callback has now had its chance to run.
    await vi.advanceTimersByTimeAsync(0);

    // This is the whole bug in #3: `Browser.open()` resolving means the tab
    // is showing, not that anybody typed a password. A caller that acted here
    // — CheckoutPage.signInAndReplay does — would replay its order with the
    // same expired token and collect a second 401.
    expect(settled).toBe(false);
    expect(strategy.accessToken()).toBeNull();

    await deliverCallback();
    await flow;

    expect(strategy.accessToken()).not.toBeNull();
  });

  it('rejects when the exchange fails, so a caller does not replay into a refusal', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    const { flow } = await startSignIn();

    await deliverCallback();

    await expect(flow).rejects.toThrow(/could not be exchanged/i);
    expect(strategy.accessToken()).toBeNull();
  });

  it('rejects when the browser is dismissed without returning, rather than dangling forever', async () => {
    // initialize registers the browserFinished listener; without it a
    // cancelled sign-in would leave its promise unsettled for the life of
    // the app, and CheckoutPage would wait on it forever.
    await strategy.initialize();
    const { flow } = await startSignIn();

    browser.finished?.();

    await expect(flow).rejects.toThrow(/dismissed/i);
  });

  it('refuses to open a second browser while a sign-in is pending', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));
    const { flow: first } = await startSignIn();
    const pendingState = strategy.pendingState();

    const second = strategy.signIn();
    await vi.advanceTimersByTimeAsync(0);

    // One browser, and the first flow's verifier and state intact. Two
    // `signIn()` calls used to mean two tabs and a verifier overwritten
    // underneath whichever one the user was part-way through (#3).
    expect(browser.open).toHaveBeenCalledOnce();
    expect(strategy.pendingState()).toBe(pendingState);

    await deliverCallback();
    await Promise.all([first, second]);

    expect(strategy.accessToken()).not.toBeNull();
  });

  it('replaces the stored refresh token on every renewal, because rotation is on', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));

    await strategy.renewNow();

    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-2');
  });

  it('signs out when a rotated token is refused', async () => {
    store.set(REFRESH_TOKEN_KEY, 'reused');
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    await strategy.renewNow();

    expect(strategy.accessToken()).toBeNull();
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('keeps the stored token when Keycloak is unreachable, because refused and unreachable are not the same answer', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await strategy.renewNow();

    // Signed out, because there is no access token to attach. But the
    // credential survives: a network that blinked says nothing about whether
    // the realm would still honour it, and discarding it would force a login
    // Keycloak never asked for.
    expect(strategy.accessToken()).toBeNull();
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(secure.remove).not.toHaveBeenCalled();
  });

  it('revokes the refresh token at Keycloak before clearing storage', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await strategy.signOut();

    expect(fetchMock.mock.calls[0][0]).toContain('/protocol/openid-connect/revoke');
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    // "Before" as an ordering, not just as "the revoke is the first fetch":
    // reading the token into a local and then clearing storage ahead of the
    // revoke call passes the two assertions above while doing the thing they
    // exist to forbid. Invocation order is what actually pins it — a
    // revocation that loses the race leaves a live refresh token at the realm
    // for its full idle timeout with nothing left on the device to kill it.
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      secure.remove.mock.invocationCallOrder[0],
    );
  });

  it('renews at 75% of the token lifetime read from exp, not at a hard-coded interval', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(225_000 - 1_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('restores a session from the stored refresh token on initialize', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));

    await strategy.initialize();

    expect(strategy.accessToken()).not.toBeNull();
    // The listener is registered by initialize, which is what makes the
    // return from the system browser reach handleCallback at all.
    expect(urlOpen.handler).not.toBeNull();
  });

  it('resolves rather than rejects when the stored credential cannot be redeemed', async () => {
    store.set(REFRESH_TOKEN_KEY, 'expired');
    fetchMock.mockRejectedValue(new Error('offline'));

    // A rejected app initializer aborts bootstrap, and main.ts only logs it:
    // the whole application would render blank because one stored credential
    // went stale (AuthService#initialize).
    await expect(strategy.initialize()).resolves.toBeUndefined();
    expect(strategy.accessToken()).toBeNull();
  });

  it('says the session survives a reload, because the token is stored', () => {
    expect(strategy.sessionEndsOnReload).toBe(false);
  });
});
