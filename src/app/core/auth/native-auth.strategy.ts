import { Injectable, InjectionToken, Signal, computed, inject, signal } from '@angular/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { environment } from '@core/config/environment';
import { AuthService, CurrentUser } from './auth.service';
import { decodeUser } from './current-user';

/**
 * The one key this strategy writes. Named rather than inlined because the
 * spec asserts it and `signOut` removes it: three literals would be three
 * chances for a sign-out that silently leaves a credential behind.
 */
export const REFRESH_TOKEN_KEY = 'blueprint.refresh';

/**
 * The three platform capabilities this strategy needs, each as a port with a
 * default factory rather than a direct import. The defaults are the real
 * Capacitor plugins, so production wiring is `NativeAuthStrategy` and nothing
 * else; a test overrides what it needs and runs with no device attached.
 *
 * The ports are narrower than the plugins on purpose. `SecureStore` is three
 * methods of a plugin that offers fourteen, and the ones left out are the
 * ones this strategy must not reach for: `keys()`, `clear()` and the iCloud
 * `setSynchronize` would each put the refresh token somewhere its owner did
 * not ask for.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SystemBrowser {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
}

export interface UrlOpenEvents {
  onUrlOpen(handler: (url: string) => void): Promise<void>;
}

export const SECURE_STORAGE = new InjectionToken<SecureStore>('SECURE_STORAGE', {
  factory: (): SecureStore => ({
    // getItem/setItem/removeItem, not get/set/remove: the plugin's `get`
    // parses ISO-8601-looking strings back into Date objects, which is the
    // wrong shape for an opaque credential. The string-in/string-out pair is
    // the one that hands back exactly what was stored.
    get: (key) => SecureStorage.getItem(key),
    set: (key, value) => SecureStorage.setItem(key, value),
    remove: (key) => SecureStorage.removeItem(key),
  }),
});

export const SYSTEM_BROWSER = new InjectionToken<SystemBrowser>('SYSTEM_BROWSER', {
  factory: (): SystemBrowser => Browser,
});

export const URL_OPEN_EVENTS = new InjectionToken<UrlOpenEvents>('URL_OPEN_EVENTS', {
  factory: (): UrlOpenEvents => ({
    onUrlOpen: async (handler) => {
      await App.addListener('appUrlOpen', (event) => handler(event.url));
    },
  }),
});

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
}

/**
 * What a token or revocation request came back as. The two failures are kept
 * apart because they call for opposite handling: Keycloak refusing a rotated
 * refresh token means that token is dead and no retry can revive it, while an
 * unreachable Keycloak says nothing about the token at all.
 */
type PostResult =
  | { readonly outcome: 'ok'; readonly body: TokenResponse }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unreachable' };

/**
 * The native half of spec §4.2.
 *
 * Sign-in is an authorization code flow with PKCE opened in the SYSTEM
 * browser and returned to over `blueprint://auth/callback`. A web view would
 * be a browser this application controls, and controlling it is precisely the
 * property a system browser has that a web view does not: the credentials the
 * user types are never in reach of this code, and the realm session is shared
 * with the rest of the device rather than sealed inside one app.
 *
 * The access token lives in memory, as it does on the web. The refresh token
 * lives in secure storage — the Keychain on iOS, EncryptedSharedPreferences
 * on Android — and NOT in Capacitor Preferences, where the cart lives: the
 * cart is a list of product ids, and this is a credential that mints access
 * tokens. Because it is stored, a relaunch restores the session, which is why
 * `sessionEndsOnReload` is false here and true on the web (spec §5.6).
 *
 * The realm rotates: `revokeRefreshToken: true` with `refreshTokenMaxReuse: 0`
 * (realm-export.json). Every renewal therefore returns a new refresh token and
 * kills the one it was redeemed with, so the stored value must be replaced on
 * each renewal or the next one presents a token Keycloak has already retired.
 */
@Injectable()
export class NativeAuthStrategy extends AuthService {
  readonly sessionEndsOnReload = false;

  private readonly secure = inject(SECURE_STORAGE);
  private readonly browser = inject(SYSTEM_BROWSER);
  private readonly urlOpen = inject(URL_OPEN_EVENTS);

  private readonly token = signal<string | null>(null);
  private readonly currentUser = computed<CurrentUser | null>(() => {
    const raw = this.token();
    return raw ? decodeUser(raw) : null;
  });

  /**
   * The pending flow's one-time values. In memory only, and correctly so: a
   * native sign-in never destroys this heap the way a web redirect does — the
   * system browser opens over the app, it does not replace it — so there is
   * nothing to survive and nothing to write down.
   */
  private verifier: string | null = null;
  private state: string | null = null;

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fraction of the token's life at which renewal fires, as on the web (spec §4.1). */
  private static readonly RENEW_AT = 0.75;

  async initialize(): Promise<void> {
    try {
      // Registered before the stored credential is read, so a callback that
      // arrives while the restore is still in flight is not dropped.
      await this.urlOpen.onUrlOpen((url) => void this.handleCallback(url));

      const stored = await this.secure.get(REFRESH_TOKEN_KEY);
      if (stored) await this.renewNow();
    } catch {
      // Must never reject: `provideAuth()` hands this promise to
      // provideAppInitializer, and a rejected initializer aborts bootstrap —
      // main.ts's bootstrapApplication(...).catch only logs it, so the whole
      // application would render blank. A locked Keychain or an unreadable
      // store leaves the user signed out on a working catalog instead
      // (AuthService#initialize, spec §5.1).
    }
  }

  async signIn(): Promise<void> {
    const verifier = randomUrlSafe(32);
    const challenge = await s256(verifier);
    const state = randomUrlSafe(16);

    this.verifier = verifier;
    this.state = state;

    const params = new URLSearchParams({
      client_id: environment.auth.nativeClientId,
      response_type: 'code',
      redirect_uri: environment.auth.nativeRedirectUri,
      scope: environment.auth.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    await this.browser.open({ url: `${endpoint('auth')}?${params}` });
  }

  /**
   * The return leg, delivered by @capacitor/app's `appUrlOpen` — which fires
   * because AndroidManifest.xml and Info.plist claim the `blueprint` scheme.
   */
  async handleCallback(url: string): Promise<void> {
    const params = new URL(url).searchParams;
    const code = params.get('code');

    if (!code || params.get('state') !== this.state) {
      // Refuse, and deliberately leave the pending verifier and state in
      // place. Clearing them here would let anyone able to fire an intent at
      // this app cancel a sign-in in progress by sending one callback with
      // the wrong state; the legitimate return would then arrive to find no
      // verifier and fail. Nothing is spent, so nothing needs resetting.
      return;
    }

    const verifier = this.verifier;
    // Spent now, before the exchange: this code and verifier are single-use,
    // and a replayed callback must not get a second exchange out of them.
    this.verifier = null;
    this.state = null;
    if (!verifier) return;

    const result = await this.post(
      endpoint('token'),
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: environment.auth.nativeClientId,
        redirect_uri: environment.auth.nativeRedirectUri,
        code,
        code_verifier: verifier,
      }),
    );

    // Closed on every outcome: the system browser is showing a page that has
    // already redirected, and leaving it in front of the app on a failed
    // exchange strands the user on it.
    await this.browser.close();

    if (result.outcome === 'ok' && result.body.access_token) await this.adopt(result.body);
  }

  /**
   * Renews from the stored refresh token. Public because the renewal timer is
   * not the only caller: `initialize` uses it to turn a stored credential
   * back into a session at launch, which is the whole reason the credential
   * is stored.
   */
  async renewNow(): Promise<void> {
    const stored = await this.secure.get(REFRESH_TOKEN_KEY);
    if (!stored) {
      await this.abandonSession();
      return;
    }

    const result = await this.post(
      endpoint('token'),
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: environment.auth.nativeClientId,
        refresh_token: stored,
      }),
    );

    if (result.outcome === 'ok' && result.body.access_token) {
      await this.adopt(result.body);
      return;
    }

    if (result.outcome === 'refused') {
      // Keycloak rejected the token. Under rotation there is no second
      // chance: either it was already redeemed or the realm retired it, and
      // in both cases retrying presents the same dead string. Drop it and
      // require an interactive sign-in.
      await this.abandonSession();
      return;
    }

    // Unreachable, not refused. The stored token may still be perfectly
    // good, so keep it and stay signed out — the next launch or the next
    // explicit sign-in retries it. Discarding a valid credential because the
    // network blinked would force a login the realm never asked for.
    this.clearRenewal();
    this.token.set(null);
  }

  async signOut(): Promise<void> {
    const stored = await this.secure.get(REFRESH_TOKEN_KEY);

    if (stored) {
      // Revoke BEFORE clearing. Clearing first would leave a live refresh
      // token at the realm and nothing left on the device to revoke it with —
      // the session would outlive the sign-out by its full idle timeout.
      await this.post(
        endpoint('revoke'),
        new URLSearchParams({
          client_id: environment.auth.nativeClientId,
          token: stored,
          token_type_hint: 'refresh_token',
        }),
      );
    }

    await this.abandonSession();
  }

  accessToken(): string | null {
    return this.token();
  }

  user(): Signal<CurrentUser | null> {
    return this.currentUser;
  }

  hasPermission(name: string): boolean {
    return this.currentUser()?.permissions.includes(name) ?? false;
  }

  /** The pending flow's `state`, for the callback to be checked against. */
  pendingState(): string | null {
    return this.state;
  }

  private async adopt(tokens: TokenResponse): Promise<void> {
    this.token.set(tokens.access_token ?? null);

    // Replace, because rotation is on: the token just redeemed is dead and
    // keeping it would break the next renewal. Absent rather than new is not
    // expected from this realm, and overwriting a working credential with
    // nothing would be worse than leaving it, so absent means keep.
    if (tokens.refresh_token) await this.secure.set(REFRESH_TOKEN_KEY, tokens.refresh_token);

    this.scheduleRenewal();
  }

  private async abandonSession(): Promise<void> {
    this.clearRenewal();
    this.token.set(null);
    try {
      await this.secure.remove(REFRESH_TOKEN_KEY);
    } catch {
      // A store that cannot be written to cannot be cleared either. The
      // in-memory token is already gone, which is what decides what this
      // client does next; a stale entry left behind is refused at the realm.
    }
  }

  private scheduleRenewal(): void {
    this.clearRenewal();

    const user = this.currentUser();
    if (!user?.expiresAt) return;

    const lifetimeMs = user.expiresAt * 1000 - Date.now();
    if (lifetimeMs <= 0) return;

    this.renewalTimer = setTimeout(
      () => void this.renewNow(),
      lifetimeMs * NativeAuthStrategy.RENEW_AT,
    );
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }

  private async post(url: string, body: URLSearchParams): Promise<PostResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      return { outcome: 'unreachable' };
    }

    if (!response.ok) return { outcome: 'refused' };

    try {
      return { outcome: 'ok', body: (await response.json()) as TokenResponse };
    } catch {
      // A 200 whose body is not JSON is the revocation endpoint's normal
      // answer, and it is not a failure: it carries no tokens and none are
      // wanted. Callers check `body.access_token` before adopting anything.
      return { outcome: 'ok', body: {} };
    }
  }
}

/**
 * Keycloak's endpoint layout, built from the configured issuer rather than
 * fetched from `.well-known/openid-configuration`. The realm is this
 * deployment's own (realm-export.json) and the paths are fixed by Keycloak,
 * so a discovery round trip at launch would buy nothing and cost the one
 * request that stands between a stored credential and a restored session.
 */
function endpoint(name: 'auth' | 'token' | 'revoke'): string {
  return `${environment.auth.issuer}/protocol/openid-connect/${name}`;
}

/**
 * `crypto.subtle` requires a secure context. Both platforms have one: Capacitor
 * serves the bundle from `https://localhost` on Android and `capacitor://localhost`
 * on iOS, and neither is a plain-http origin. (jsdom has no `subtle` at all,
 * which is why the spec stubs Node's WebCrypto over it.)
 */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function randomUrlSafe(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
