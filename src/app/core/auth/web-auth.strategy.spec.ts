import { TestBed } from '@angular/core/testing';
import { OAuthService } from 'angular-oauth2-oidc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuthStrategy } from './web-auth.strategy';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

class FakeOAuth {
  token: string | null = null;
  silentRefresh = vi.fn(async () => undefined);
  logOut = vi.fn();
  initCodeFlow = vi.fn();
  configure = vi.fn();
  setStorage = vi.fn();
  loadDiscoveryDocumentAndTryLogin = vi.fn(async () => true);
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

  it('never writes to localStorage or sessionStorage during initialize', async () => {
    const localSetItem = vi.spyOn(Storage.prototype, 'setItem');
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });

    await strategy.initialize();

    expect(localSetItem).not.toHaveBeenCalled();
    localSetItem.mockRestore();
  });
});
