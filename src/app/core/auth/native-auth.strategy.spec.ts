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
function fiveMinuteToken(username = 'demo'): string {
  return jwt({
    preferred_username: username,
    sub: 's',
    permission: ['orders:write'],
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

function tokenResponse(refresh: string, username = 'demo') {
  return {
    ok: true,
    json: async () => ({ access_token: fiveMinuteToken(username), refresh_token: refresh }),
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
    // clearAllMocks resets recorded calls but KEEPS implementations, so a
    // test that makes the store fail would otherwise leak that failure into
    // every test after it. Re-establish the working store each time.
    secure.get.mockImplementation(async (k: string) => store.get(k) ?? null);
    secure.set.mockImplementation(async (k: string, v: string) => void store.set(k, v));
    secure.remove.mockImplementation(async (k: string) => void store.delete(k));
    browser.open.mockImplementation(async () => undefined);
    browser.close.mockImplementation(async () => undefined);
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

  it('closes the browser and clears the flow when the callback carries an OAuth error', async () => {
    const { flow } = await startSignIn();
    const state = strategy.pendingState();

    // Keycloak answers a denial by redirecting to the SAME redirect_uri with
    // `error` and the original `state` and no `code`. Treating that as "not
    // ours" left the tab open over the app with the flow still pending.
    await strategy.handleCallback(
      `blueprint://auth/callback?error=access_denied&error_description=denied&state=${state}`,
    );

    await expect(flow).rejects.toThrow(/access_denied/);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(strategy.pendingState()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the stored token when Keycloak answers 503, because a server fault is not a refusal', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await strategy.renewNow();

    // Deleting the credential here would turn one bad minute at the identity
    // provider into a forced interactive sign-in. Only a refusal of the
    // GRANT means the token is dead.
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(strategy.accessToken()).toBeNull();
  });

  it('keeps the stored token when Keycloak answers 429, for the same reason', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    await strategy.renewNow();

    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('does not sign the user back in when a renewal lands after sign-out', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');

    // A renewal whose response is still in flight when the user signs out.
    let releaseRenewal!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseRenewal = resolve)),
    );
    const renewal = strategy.renewNow();
    // Wait until the token request is genuinely in flight before signing out.
    // Without this the sign-out's generation bump lands while the renewal is
    // still on its storage READ, so it bails there and never reaches the
    // network — testing the wrong guard, and leaving the suspended mock to be
    // picked up by the revocation instead.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    // Sign out completes while that request is outstanding.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();
    expect(strategy.accessToken()).toBeNull();

    // Now the renewal's response arrives, carrying a perfectly good token.
    releaseRenewal(tokenResponse('refresh-2'));
    await renewal;

    // Adopting it would resurrect a session the user ended, and would write a
    // credential back into storage they asked to have cleared.
    expect(strategy.accessToken()).toBeNull();
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('survives a renewal that throws, rather than raising an unhandled rejection', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();

    // A locked Keychain: the scheduled renewal cannot even read the token.
    // The timer calls this with no caller to catch it, so the strategy must.
    secure.get.mockRejectedValueOnce(new Error('keychain is locked'));

    await vi.advanceTimersByTimeAsync(225_000);

    // The assertion is that this test did not fail: vitest fails a test on an
    // unhandled rejection, which is what `void this.renewNow()` produced.
    expect(strategy.accessToken()).toBeNull();
  });

  it('sends a code challenge that is the real S256 digest of the verifier it redeems', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));
    const { flow } = await startSignIn();

    const authorizeUrl = new URL(browser.open.mock.calls[0][0].url);
    const challenge = authorizeUrl.searchParams.get('code_challenge');

    await deliverCallback();
    await flow;

    // The verifier is private, so take it from the exchange the strategy
    // actually sent and recompute the digest over it. Asserting only
    // `code_challenge_method=S256` would pass for a challenge that was a
    // stand-in, a truncation, or standard base64 — each of which Keycloak
    // refuses at the exchange, on a device, with no unit test complaining.
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1].body));
    const verifier = body.get('code_verifier');
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier!));
    const expected = Buffer.from(digest)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(challenge).toBe(expected);
  });

  it('two callers racing before the digest resolves still get one browser and one outcome', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));

    // Synchronously, with no await between them: the in-flight guard has to
    // hold across `signIn`'s FIRST await (the S256 digest), not merely at its
    // entry. Guarding at entry while claiming the slot after the digest let
    // both callers through, and the loser's promise was abandoned unsettled.
    const first = strategy.signIn();
    const second = strategy.signIn();

    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
    expect(browser.open).toHaveBeenCalledOnce();

    await deliverCallback();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('fails every joined caller when the browser cannot be opened at all', async () => {
    browser.open.mockRejectedValueOnce(new Error('no browser available'));

    const first = strategy.signIn();
    const second = strategy.signIn();

    await expect(first).rejects.toThrow(/no browser/);
    // The second caller holds the same promise. Clearing the record without
    // settling it left this one waiting for the life of the app.
    await expect(second).rejects.toThrow(/no browser/);
    expect(strategy.pendingState()).toBeNull();
  });

  it('rejects the flow when the token arrives but secure storage refuses it', async () => {
    fetchMock.mockResolvedValue(tokenResponse('refresh-1'));
    secure.set.mockRejectedValueOnce(new Error('keychain is locked'));
    const { flow } = await startSignIn();

    await deliverCallback();

    await expect(flow).rejects.toThrow(/keychain/);
    // adopt() puts the access token in memory BEFORE it writes the refresh
    // token, so a throw there used to leave a half-session: a token in
    // memory, a promise nobody would ever settle, and no renewal scheduled.
    expect(strategy.accessToken()).toBeNull();
  });

  it('does not leave a refresh token behind when sign-out lands during the storage write', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');

    // Suspend adopt()'s write, sign out underneath it, then let it finish.
    let releaseWrite!: () => void;
    secure.set.mockImplementationOnce(
      (k: string, v: string) =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => {
            store.set(k, v);
            resolve(undefined);
          };
        }),
    );
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    const renewal = strategy.renewNow();
    await vi.waitFor(() => expect(secure.set).toHaveBeenCalled());

    await strategy.signOut();
    releaseWrite();
    await renewal;

    // The generation check before adopt() is not enough on its own: the write
    // inside adopt() is itself an await, and a sign-out crossing it put the
    // credential back into storage the user had just cleared.
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(strategy.accessToken()).toBeNull();
  });

  it('signs out locally even when the credential cannot be read', async () => {
    // A live session first, so there is something for sign-out to clear.
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();
    expect(strategy.accessToken()).not.toBeNull();

    // Now the store goes unreadable, for THIS call and not the setup above.
    secure.get.mockRejectedValueOnce(new Error('keychain is locked'));

    await expect(strategy.signOut()).resolves.toBeUndefined();

    // A store that cannot be read cannot be revoked from either. Rejecting
    // here left the access token in memory and the UI signed in because the
    // Keychain was briefly busy, which is the one outcome nobody asked for.
    expect(strategy.accessToken()).toBeNull();
  });

  it('settles the flow when the S256 digest itself fails', async () => {
    // crypto.subtle missing or refusing. The pending record is claimed before
    // this await, so a throw here used to leave it set and unsettled — and
    // the NEXT sign-in joined that promise forever, with no browser ever
    // opened and so no dismissal event to rescue it.
    vi.stubGlobal('crypto', {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: { digest: () => Promise.reject(new Error('no subtle crypto')) },
    });

    await expect(strategy.signIn()).rejects.toThrow(/no subtle crypto/);
    expect(strategy.pendingState()).toBeNull();

    // And the next attempt is a fresh flow rather than a join onto a dead one.
    vi.stubGlobal('crypto', webcrypto);
    const { flow } = await startSignIn();
    expect(strategy.pendingState()).not.toBeNull();
    void flow.catch(() => undefined);
  });

  it('does not resurrect the session when sign-out crosses the code exchange', async () => {
    // The exchange is in flight when the user signs out.
    let releaseExchange!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseExchange = resolve)),
    );
    const { flow } = await startSignIn();
    const callback = deliverCallback();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();

    releaseExchange(tokenResponse('refresh-1'));
    await callback;
    await flow.catch(() => undefined);

    // handleCallback captures the generation BEFORE the exchange; adopting on
    // the generation current when the response lands would sign the user
    // straight back in after they left.
    expect(strategy.accessToken()).toBeNull();
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('a stale renewal does not tear down a session that started after it', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');

    // A renewal whose write is suspended; the user signs out, then signs in
    // again, before it resumes.
    let releaseWrite!: () => void;
    secure.set.mockImplementationOnce(
      (k: string, v: string) =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => {
            store.set(k, v);
            resolve(undefined);
          };
        }),
    );
    fetchMock.mockResolvedValue(tokenResponse('stale'));
    const stale = strategy.renewNow();
    await vi.waitFor(() => expect(secure.set).toHaveBeenCalled());

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();

    // A whole new session, established while the stale write is still parked.
    store.set(REFRESH_TOKEN_KEY, 'brand-new');
    // A different username, so this session's token is a different string
    // from the stale one and the assertions below cannot pass by accident.
    fetchMock.mockResolvedValue(tokenResponse('brand-new-2', 'second-session'));
    await strategy.renewNow();
    expect(strategy.user()()?.username).toBe('second-session');

    releaseWrite();
    await stale;

    // What is guaranteed: the new session is NOT logged out. An unconditional
    // rollback cleared the token signal and deleted the shared key, which
    // ended a session that had nothing to do with the renewal being undone.
    expect(strategy.user()()?.username).toBe('second-session');

    // What is NOT guaranteed, and is documented rather than fixed: the stale
    // write was already in flight, so it landed on top of the new session's
    // value before the rollback removed it. The new session therefore has no
    // STORED credential until its next renewal writes one — it stays signed
    // in on the token in memory, and the window self-heals. Closing it would
    // need a compare-and-set the Preferences/Keychain API does not offer, or a
    // write queue holding a generation check inside its critical section; both
    // are a lot of machinery for a window measured in milliseconds whose
    // consequence repairs itself. What matters is that the stale value does
    // not survive to be presented to Keycloak.
    expect(store.get(REFRESH_TOKEN_KEY)).not.toBe('stale');
  });

  it('a late exchange does not delete the credential of the session that replaced it', async () => {
    // The distinguishing case for `discard`'s value check. Here the stale
    // tokens never reach storage at all — the exchange is still in flight
    // when the session ends — so at rollback time the key holds the NEW
    // session's value. Removing by key alone would delete it.
    let releaseExchange!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseExchange = resolve)),
    );
    const { flow } = await startSignIn();
    const callback = deliverCallback();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();

    // A whole new session while that exchange is still parked.
    store.set(REFRESH_TOKEN_KEY, 'brand-new');
    fetchMock.mockResolvedValue(tokenResponse('brand-new-2', 'second-session'));
    await strategy.renewNow();
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('brand-new-2');

    releaseExchange(tokenResponse('stale-1'));
    await callback;
    await flow.catch(() => undefined);

    expect(store.get(REFRESH_TOKEN_KEY)).toBe('brand-new-2');
    expect(strategy.user()()?.username).toBe('second-session');
  });

  it('does not let the renewal timer fire while the revocation is in flight', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();
    fetchMock.mockClear();

    // Sign out, with the revocation request parked.
    let releaseRevoke!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseRevoke = resolve)),
    );
    const signOut = strategy.signOut();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    // Long enough for the 75% renewal to come due. Sign-out ends the session
    // BEFORE it reads or revokes anything, so the timer is already cancelled:
    // a renewal firing here would redeem the very token being revoked and
    // rotate it to one nothing will ever revoke.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    releaseRevoke({ ok: true, json: async () => ({}) });
    await signOut;

    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('a stale empty-store renewal does not tear down a newer session', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();

    // A renewal whose storage READ is suspended, and which will come back
    // empty-handed. Its no-token branch used to call abandonSession()
    // unconditionally.
    let releaseRead!: (value: string | null) => void;
    secure.get.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (releaseRead = resolve)),
    );
    const stale = strategy.renewNow();
    await vi.waitFor(() => expect(secure.get).toHaveBeenCalled());

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();

    store.set(REFRESH_TOKEN_KEY, 'brand-new');
    fetchMock.mockResolvedValue(tokenResponse('brand-new-2', 'second-session'));
    await strategy.renewNow();

    releaseRead(null);
    await stale;

    expect(strategy.user()()?.username).toBe('second-session');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('brand-new-2');
  });

  it('keeps a still-valid session when a renewal cannot reach Keycloak, and tries again', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();
    fetchMock.mockClear();

    // Renewal fires at 75% of a five-minute token, so a quarter of its life —
    // 75 seconds — is still ahead of it. Signing the user out at the first
    // failed attempt throws away a token that still works.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(225_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(strategy.accessToken()).not.toBeNull();
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('refresh-2');

    // And it retries, at 75% of whatever life is left — a backoff that comes
    // out of the token's own exp rather than a number chosen here.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not destroy a session established while the sign-out was still in flight', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();

    let releaseRevoke!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseRevoke = resolve)),
    );
    const signOut = strategy.signOut();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // A fresh interactive sign-in, started AFTER the sign-out began and
    // completing before its revocation returns — the checkout 401 path can do
    // exactly this.
    fetchMock.mockResolvedValue(tokenResponse('after-signout', 'second-session'));
    const { flow } = await startSignIn();
    await deliverCallback();
    await flow;
    expect(strategy.user()()?.username).toBe('second-session');

    releaseRevoke({ ok: true, json: async () => ({}) });
    await signOut;

    // The sign-out's own cleanup must not reach past the session it ended.
    expect(strategy.user()()?.username).toBe('second-session');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('after-signout');
  });

  it('abandons a sign-in that was already in flight when the user signed out', async () => {
    await strategy.initialize();
    const { flow } = await startSignIn();
    const state = strategy.pendingState();

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await strategy.signOut();

    await expect(flow).rejects.toThrow(/sign-out/i);
    // The browser showing the login page is closed with it.
    expect(browser.close).toHaveBeenCalled();

    // And the return leg, if it arrives anyway, signs nobody in: signing out
    // is the later instruction, and a flow started before it does not
    // override it.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(tokenResponse('sneaky'));
    await strategy.handleCallback(`blueprint://auth/callback?code=abc&state=${state}`);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(strategy.accessToken()).toBeNull();
  });

  it('reports a sign-out that could not clear the stored credential', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();

    // Revocation unreachable AND the store refusing to remove or overwrite:
    // the credential survives, and initialize() would restore it on the next
    // launch — a sign-out that silently did not sign anybody out.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    secure.remove.mockRejectedValue(new Error('keychain is locked'));
    secure.set.mockRejectedValue(new Error('keychain is locked'));

    await expect(strategy.signOut()).rejects.toThrow(/keychain/);

    // Memory is cleared regardless — the user asked to sign out.
    expect(strategy.accessToken()).toBeNull();
  });

  it('neutralises the stored credential when it cannot be removed', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    await strategy.renewNow();

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    secure.remove.mockRejectedValueOnce(new Error('cannot remove'));

    await expect(strategy.signOut()).resolves.toBeUndefined();

    // Overwritten with an empty value rather than left intact: `read` treats
    // empty as absent, so the next launch restores nothing.
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('');
    expect(strategy.accessToken()).toBeNull();
  });

  it('does not leave a half-session when a renewal cannot write the rotated token', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockResolvedValue(tokenResponse('refresh-2'));
    secure.set.mockRejectedValueOnce(new Error('keychain is locked'));

    await expect(strategy.renewNow()).rejects.toThrow(/keychain/);

    // `adopt` sets the access token before it writes, and `initialize`
    // swallows what `renewNow` throws — so without a rollback here a locked
    // Keychain at launch left a token in memory that nothing would renew.
    expect(strategy.accessToken()).toBeNull();
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

  it('signs out locally even when the revocation cannot be delivered', async () => {
    store.set(REFRESH_TOKEN_KEY, 'refresh-1');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await strategy.signOut();

    // A deliberate choice, not an oversight: the realm session outlives the
    // sign-out until its idle timeout, and nobody holds a token to use in the
    // meantime because the only copy is gone. Keeping the credential on the
    // device so the revocation could be retried would leave it available to
    // whoever picks up a device its owner has finished with.
    expect(strategy.accessToken()).toBeNull();
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
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
