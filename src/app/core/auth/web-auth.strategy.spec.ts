import { TestBed } from '@angular/core/testing';
import { OAuthService } from 'angular-oauth2-oidc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HybridOAuthStorage, TRANSIENT_STORAGE_KEYS, WebAuthStrategy } from './web-auth.strategy';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

class FakeOAuth {
  token: string | null = null;
  // Mirrors the real OAuthService: starts false, and the fixture for each
  // test sets it the way loadDiscoveryDocument() would have left it (see
  // angular-oauth2-oidc.mjs:974 and :1331 — set true only once discovery's
  // own success path runs, never cleared back to false).
  discoveryDocumentLoaded = false;
  silentRefresh = vi.fn(async () => undefined);
  // The real logOut() removes access_token (among other keys) from
  // OAuthService's storage (angular-oauth2-oidc.mjs:2731) before getAccessToken()
  // is next read — mirrored here so a test can tell logOut() was actually
  // effective, not just called.
  logOut = vi.fn(() => {
    this.token = null;
  });
  initCodeFlow = vi.fn();
  configure = vi.fn();
  setStorage = vi.fn();
  loadDiscoveryDocument = vi.fn(async () => {
    this.discoveryDocumentLoaded = true;
    return {} as unknown;
  });
  loadDiscoveryDocumentAndTryLogin = vi.fn(async () => {
    this.discoveryDocumentLoaded = true;
    return true;
  });
  getAccessToken = () => this.token;
}

describe('WebAuthStrategy', () => {
  let oauth: FakeOAuth;
  let strategy: WebAuthStrategy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    oauth = new FakeOAuth();

    TestBed.configureTestingModule({
      providers: [WebAuthStrategy, { provide: OAuthService, useValue: oauth }],
    });

    strategy = TestBed.inject(WebAuthStrategy);
  });

  afterEach(() => vi.useRealTimers());

  it('adopts the token and exposes its claims', async () => {
    oauth.token = jwt({
      preferred_username: 'demo',
      sub: 's',
      permission: ['catalog:write'],
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await strategy.initialize();

    expect(strategy.user()()?.username).toBe('demo');
    expect(strategy.hasPermission('catalog:write')).toBe(true);
    expect(strategy.hasPermission('orders:write')).toBe(false);
  });

  it('renews at 75% of the token lifetime read from exp, not at a hard-coded interval', async () => {
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });
    await strategy.initialize();

    // 75% of 300s. One tick short, nothing has fired.
    await vi.advanceTimersByTimeAsync(225_000 - 1_000);
    expect(oauth.silentRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(oauth.silentRefresh).toHaveBeenCalledOnce();
  });

  it('renews at 75% of a different token lifetime, proving the fraction is read from exp rather than fixed at 225s', async () => {
    // A 120s lifetime: 75% is 90s, nowhere near the 225s the 300s-lifetime
    // test above would also pass under if the strategy ignored exp and
    // always waited a hard-coded 225 seconds.
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 120 });
    await strategy.initialize();

    await vi.advanceTimersByTimeAsync(90_000 - 1_000);
    expect(oauth.silentRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(oauth.silentRefresh).toHaveBeenCalledOnce();
  });

  it('signs the user out when Keycloak answers login_required', async () => {
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });
    await strategy.initialize();

    oauth.silentRefresh.mockRejectedValueOnce(new Error('login_required'));
    await vi.advanceTimersByTimeAsync(225_000);

    expect(strategy.accessToken()).toBeNull();
    expect(strategy.user()()).toBeNull();
  });

  it('ends the Keycloak session on sign-out, not just the local one', async () => {
    await strategy.signOut();
    expect(oauth.logOut).toHaveBeenCalledOnce();
  });

  it('says the session ends on reload, because the realm issues no refresh token', () => {
    expect(strategy.sessionEndsOnReload).toBe(true);
  });

  it(
    'resolves rather than rejecting when the identity provider is unreachable, leaving the user signed out',
    async () => {
      // Regression test for the defect this task fixes: an unhandled
      // rejection here propagates through provideAppInitializer and aborts
      // Angular bootstrap entirely (auth.providers.ts), blanking the whole
      // app — including the anonymous product catalog that needs no token.
      oauth.loadDiscoveryDocumentAndTryLogin.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));

      await expect(strategy.initialize()).resolves.toBeUndefined();

      expect(strategy.accessToken()).toBeNull();
      expect(strategy.user()()).toBeNull();
    },
  );

  it(
    'clears a token the library already stored when tryLogin rejects after fetchAndProcessToken wrote it',
    async () => {
      // fetchAndProcessToken (angular-oauth2-oidc.mjs:2249-2300) calls
      // storeAccessTokenResponse() — which writes access_token to
      // OAuthService's storage — BEFORE it awaits processIdToken() a few
      // lines later. An id_token that then fails validation rejects
      // tryLoginCodeFlow with that access_token already sitting in storage,
      // even though this strategy never adopted it. Simulate exactly that:
      // discoveryDocumentLoaded ends up true (discovery itself succeeded —
      // this is the tryLogin branch, not the discovery-unreachable one) and
      // a token is already sitting in the fake's storage when the rejection
      // happens.
      oauth.loadDiscoveryDocumentAndTryLogin.mockImplementationOnce(async () => {
        oauth.discoveryDocumentLoaded = true;
        oauth.token = 'stored-by-fetchAndProcessToken-but-never-adopted';
        throw new Error('token_validation_error');
      });

      await strategy.initialize();

      expect(strategy.accessToken()).toBeNull();
      expect(oauth.getAccessToken()).toBeNull();
      expect(oauth.logOut).toHaveBeenCalledWith(true);
    },
  );

  it(
    'retries discovery on signIn() after a failed initialize(), and only then starts the code flow',
    async () => {
      // Against the unfixed code, signIn() calls initCodeFlow()
      // unconditionally and never touches loadDiscoveryDocument — this
      // assertion is what catches that: initCodeFlow() would have nothing to
      // navigate to (loginUrl is still '' because discovery never
      // succeeded), silently doing nothing forever.
      //
      // The setup call tolerates a rejection (`.catch(() => {})`) rather than
      // a bare `await`, deliberately: against the unfixed initialize() (no
      // try/catch at all) an unguarded await here throws before this test
      // ever reaches its signIn() assertions, so the test would fail for
      // "initialize() rejected" regardless of what signIn() does — proving
      // nothing about the retry behaviour this test is named for.
      oauth.loadDiscoveryDocumentAndTryLogin.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));
      await strategy.initialize().catch(() => undefined);

      await strategy.signIn();

      expect(oauth.loadDiscoveryDocument).toHaveBeenCalledOnce();
      expect(oauth.initCodeFlow).toHaveBeenCalledOnce();
    },
  );

  it(
    'surfaces a second discovery failure from signIn() instead of swallowing it',
    async () => {
      // Against the unfixed code this never rejects — signIn() is
      // `async signIn(): Promise<void> { this.oauth.initCodeFlow(); }`, which
      // always resolves regardless of whether the identity provider is
      // reachable. That is the silent no-op the brief calls a worse bug than
      // the blank-app one.
      //
      // Same reasoning as the test above for tolerating the setup rejection:
      // this test's failure must come from the `signIn()` assertion, not
      // from an unguarded `await strategy.initialize()` throwing first.
      oauth.loadDiscoveryDocumentAndTryLogin.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));
      await strategy.initialize().catch(() => undefined);
      oauth.loadDiscoveryDocument.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));

      await expect(strategy.signIn()).rejects.toThrow('ERR_CONNECTION_REFUSED');

      expect(oauth.initCodeFlow).not.toHaveBeenCalled();
    },
  );

  it(
    'does not retry discovery on signIn() when initialize() succeeded, even signed out',
    async () => {
      // discoveryDocumentLoaded is true here (initialize()'s happy path ran),
      // so signIn() must call initCodeFlow() straight away — an unnecessary
      // retry would just be a slower version of the same button.
      await strategy.initialize();

      await strategy.signIn();

      expect(oauth.loadDiscoveryDocument).not.toHaveBeenCalled();
      expect(oauth.initCodeFlow).toHaveBeenCalledOnce();
    },
  );
});

/**
 * These exercise HybridOAuthStorage directly rather than through
 * WebAuthStrategy with a fake OAuthService, because a fake OAuthService never
 * calls the storage at all — a test that spies on Storage.prototype.setItem
 * around a fake would pass whether or not the storage were wired correctly,
 * proving nothing about the property that matters here.
 */
describe('HybridOAuthStorage', () => {
  const TOKEN_KEYS = [
    'access_token',
    'refresh_token',
    'id_token',
    'id_token_claims_obj',
    'expires_at',
    'access_token_stored_at',
    'id_token_stored_at',
    'id_token_expires_at',
    'granted_scopes',
    'session_state',
  ];

  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('writes exactly the flow-transient keys to sessionStorage and keeps every token key out of it', () => {
    const storage = new HybridOAuthStorage();

    for (const key of TRANSIENT_STORAGE_KEYS) storage.setItem(key, `${key}-value`);
    for (const key of TOKEN_KEYS) storage.setItem(key, `${key}-value`);

    for (const key of TRANSIENT_STORAGE_KEYS) {
      expect(sessionStorage.getItem(key)).toBe(`${key}-value`);
    }
    for (const key of TOKEN_KEYS) {
      expect(sessionStorage.getItem(key)).toBeNull();
      // Still readable — it went to the in-memory branch, not nowhere.
      expect(storage.getItem(key)).toBe(`${key}-value`);
    }
  });

  it(
    'keeps a PKCE verifier across a simulated redirect reload, and drops an access token across the same reload',
    () => {
      // A page reload — which is exactly what happens between initCodeFlow()'s
      // top-level navigation to Keycloak and the app rebooting on the way back
      // — destroys the JS heap and constructs a brand new WebAuthStrategy, and
      // therefore a brand new HybridOAuthStorage. This is the regression test
      // for the redirect defect: against a pure in-memory store (the brief's
      // original `as Storage` cast, or the library's own MemoryStorage), the
      // PKCE_verifier assertion below would fail, because nothing written to a
      // Map survives the instance being thrown away and rebuilt.
      const beforeReload = new HybridOAuthStorage();
      beforeReload.setItem('PKCE_verifier', 'verifier-123');
      beforeReload.setItem('access_token', 'should-not-survive-a-reload');

      const afterReload = new HybridOAuthStorage();

      expect(afterReload.getItem('PKCE_verifier')).toBe('verifier-123');
      expect(afterReload.getItem('access_token')).toBeNull();
    },
  );

  it('removeItem clears a transient key from sessionStorage and a token key from memory', () => {
    const storage = new HybridOAuthStorage();
    storage.setItem('PKCE_verifier', 'verifier-123');
    storage.setItem('access_token', 'a-token');

    storage.removeItem('PKCE_verifier');
    storage.removeItem('access_token');

    expect(sessionStorage.getItem('PKCE_verifier')).toBeNull();
    expect(storage.getItem('PKCE_verifier')).toBeNull();
    expect(storage.getItem('access_token')).toBeNull();
  });
});

describe('WebAuthStrategy transient-key cleanup', () => {
  let oauth: FakeOAuth;
  let strategy: WebAuthStrategy;

  beforeEach(() => {
    // Fake timers so scheduleRenewal()'s setTimeout (fired by adopt(), which
    // this describe block exercises) never becomes a real, ~225-second
    // pending timer left dangling after the test completes.
    vi.useFakeTimers();
    sessionStorage.clear();
    oauth = new FakeOAuth();

    TestBed.configureTestingModule({
      providers: [WebAuthStrategy, { provide: OAuthService, useValue: oauth }],
    });

    strategy = TestBed.inject(WebAuthStrategy);
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('clears the transient sessionStorage keys once a token is adopted', async () => {
    // The library itself only clears PKCE_verifier/nonce on logOut(), so a
    // spent verifier would otherwise sit in sessionStorage until sign-out.
    sessionStorage.setItem('PKCE_verifier', 'verifier-123');
    sessionStorage.setItem('nonce', 'nonce-123');
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });

    await strategy.initialize();

    expect(sessionStorage.getItem('PKCE_verifier')).toBeNull();
    expect(sessionStorage.getItem('nonce')).toBeNull();
  });
});
