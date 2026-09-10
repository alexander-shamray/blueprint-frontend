import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { AuthConfig, OAuthService, OAuthStorage } from 'angular-oauth2-oidc';
import { environment } from '@core/config/environment';
import { AuthService, CurrentUser } from './auth.service';
import { decodeUser } from './current-user';

/**
 * Keys the library writes before a top-level redirect to Keycloak and reads
 * back after Keycloak redirects to the app. A redirect destroys the JS heap,
 * so anything needed on the way back cannot live only in memory — this is
 * exactly the PKCE verifier and the OIDC nonce, plus `requested_route` if
 * `preserveRequestedRoute` were ever turned on (it is not, here).
 *
 * This is an ALLOWLIST of the flow's transient keys, not a denylist of the
 * token keys, and the direction is load-bearing: a key a future library
 * version adds and this list does not know about falls through to the
 * memory branch below, which is safe (it just would not survive a redirect,
 * same as today). Under a denylist, an unrecognised new key would default to
 * `sessionStorage` — a credential leaking to web storage because nobody
 * reviewed a dependency bump.
 *
 * Verified against angular-oauth2-oidc@22.0.2's fesm2022 bundle by finding
 * every `_storage.setItem(...)` call site (a `getItem`/`removeItem`-only key
 * would not have shown up that way, so setItem is the correct one to grep).
 * The complete set the library writes is exactly these three transient keys
 * plus nine token/session-bookkeeping keys: access_token, refresh_token,
 * id_token, id_token_claims_obj, expires_at, access_token_stored_at,
 * id_token_stored_at, id_token_expires_at, granted_scopes, session_state —
 * all nine stay in memory via the fallback branch.
 */
export const TRANSIENT_STORAGE_KEYS: ReadonlySet<string> = new Set([
  'PKCE_verifier',
  'nonce',
  'requested_route',
]);

/**
 * Routes each key the library asks to store: the three flow-transient keys
 * above go to `sessionStorage` (it dies with the tab, which is the closest
 * browser storage gets to the posture the realm chose — `localStorage` would
 * outlive the tab, which this spec's "a reload signs you out" does not
 * intend to allow); every other key — every token, and the claims/session
 * bookkeeping the library derives from them — stays in a plain in-memory Map
 * that a redirect destroys along with the rest of the page.
 *
 * A plain `MemoryStorage` (the library's own, in `angular-oauth2-oidc`) is
 * not enough on its own: `initCodeFlow()`'s default `openUri` is a real
 * top-level navigation (`location.href = uri`), which destroys that Map
 * before Keycloak redirects back. The code exchange that follows then finds
 * no PKCE verifier, omits `code_verifier` from the token request, and
 * `web-app` (PKCE S256, required) is rejected by Keycloak — the user
 * completes the login screen and lands back signed out. `silentRefresh()` is
 * unaffected by this because its PKCE round trip happens inside a hidden
 * iframe in the same document, so the parent page's memory is never
 * destroyed; only the interactive, redirect-based sign-in needs the
 * transient keys to survive outside the heap.
 */
export class HybridOAuthStorage implements OAuthStorage {
  private readonly memory = new Map<string, string>();

  getItem(key: string): string | null {
    if (TRANSIENT_STORAGE_KEYS.has(key)) return sessionStorage.getItem(key);
    return this.memory.get(key) ?? null;
  }

  setItem(key: string, data: string): void {
    if (TRANSIENT_STORAGE_KEYS.has(key)) {
      sessionStorage.setItem(key, data);
      return;
    }
    this.memory.set(key, data);
  }

  removeItem(key: string): void {
    if (TRANSIENT_STORAGE_KEYS.has(key)) {
      sessionStorage.removeItem(key);
      return;
    }
    this.memory.delete(key);
  }
}

/**
 * The browser half of spec §4.1.
 *
 * Tokens are held in memory only — no localStorage, no sessionStorage. A page
 * reload signs the user out, and that is the honest consequence of the realm's
 * `use.refresh.tokens: "false"` on `web-app` rather than an oversight; the
 * account page says so in a sentence (spec §5.6). The one exception is the
 * flow-transient keys HybridOAuthStorage routes to `sessionStorage` above —
 * a single-use, non-identifying PKCE verifier and nonce, not a credential,
 * and worthless to anyone who steals it without also holding the matching
 * authorization code.
 *
 * Renewal is a silent code flow in a hidden iframe with prompt=none, because
 * there IS no refresh token to use. The schedule comes from the token's own
 * `exp`, so moving accessTokenLifespan in the realm moves the schedule without
 * a client release.
 */
@Injectable()
export class WebAuthStrategy extends AuthService {
  readonly sessionEndsOnReload = true;

  private readonly oauth = inject(OAuthService);
  private readonly token = signal<string | null>(null);
  private readonly currentUser = computed<CurrentUser | null>(() => {
    const raw = this.token();
    return raw ? decodeUser(raw) : null;
  });

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fraction of the token's life at which the silent renewal fires (spec §4.1). */
  private static readonly RENEW_AT = 0.75;

  async initialize(): Promise<void> {
    const config: AuthConfig = {
      issuer: environment.auth.issuer,
      clientId: environment.auth.webClientId,
      redirectUri: environment.auth.redirectUri,
      silentRefreshRedirectUri: `${environment.auth.redirectUri}silent-refresh.html`,
      responseType: 'code',
      scope: environment.auth.scope,
      requireHttps: environment.production,
      showDebugInformation: !environment.production,
      // Consulted by the library's own session-check/auto-refresh machinery
      // (which this strategy does not use — see scheduleRenewal below) to
      // prefer the silent-refresh iframe over a refresh_token grant. Kept
      // true so a future caller of that machinery still gets the strategy
      // that actually works against a client with no refresh token.
      useSilentRefresh: true,
      // web-app is a public client with PKCE required (pkce.code.challenge.method:
      // S256 in the realm export) — PKCE must stay enabled.
      disablePKCE: false,
    };

    this.oauth.configure(config);
    // See HybridOAuthStorage above for why a plain in-memory store is not
    // enough on its own for the redirect-based sign-in path.
    this.oauth.setStorage(new HybridOAuthStorage());

    await this.oauth.loadDiscoveryDocumentAndTryLogin();

    const token = this.oauth.getAccessToken();
    if (token) this.adopt(token);
  }

  async signIn(): Promise<void> {
    this.oauth.initCodeFlow();
  }

  async signOut(): Promise<void> {
    this.clearRenewal();
    this.token.set(null);
    // Ends the Keycloak session through the end-session endpoint, not just the
    // local one: a local-only sign-out leaves the realm session alive and the
    // next sign-in silently succeeds without a prompt, which looks like the
    // sign-out did not work.
    this.oauth.logOut();
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

  private adopt(token: string): void {
    this.token.set(token);
    this.scheduleRenewal();
    // The library only clears PKCE_verifier/nonce from storage on logOut()
    // (angular-oauth2-oidc.mjs:2738-2740) — not once the code exchange that
    // needed them has succeeded. Once a token is adopted, both have done
    // their one-time job, so clear them out of sessionStorage rather than
    // let a spent, if harmless, verifier sit there until sign-out.
    for (const key of TRANSIENT_STORAGE_KEYS) sessionStorage.removeItem(key);
  }

  private scheduleRenewal(): void {
    this.clearRenewal();

    const user = this.currentUser();
    if (!user?.expiresAt) return;

    const lifetimeMs = user.expiresAt * 1000 - Date.now();
    if (lifetimeMs <= 0) return;

    this.renewalTimer = setTimeout(() => void this.renew(), lifetimeMs * WebAuthStrategy.RENEW_AT);
  }

  private async renew(): Promise<void> {
    try {
      // silentRefresh(), not refreshToken(): refreshToken() performs an
      // OAuth refresh_token grant, which this client has nothing to redeem
      // (the realm's `use.refresh.tokens: "false"` on web-app means Keycloak
      // never issues one). silentRefresh() instead builds a fresh
      // authorization-code + PKCE URL (createLoginUrl, driven by this
      // strategy's responseType: 'code' and disablePKCE: false above),
      // appends prompt=none, and loads it in a hidden iframe
      // (silentRefreshShowIFrame defaults to false) — an interaction-free
      // rerun of the code flow, which is the only renewal path this realm
      // supports. Its own doc comment says "for implicit flow", but the
      // implementation branches on responseType and does PKCE for code flow
      // too (angular-oauth2-oidc 22.0.2, fesm2022/angular-oauth2-oidc.mjs).
      await this.oauth.silentRefresh();
      const token = this.oauth.getAccessToken();
      if (token) this.adopt(token);
    } catch {
      // Keycloak answered login_required: the SSO session is gone. Drop the
      // token rather than retrying — the next protected action prompts an
      // interactive sign-in, which is the only thing that can help.
      this.token.set(null);
    }
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }
}
