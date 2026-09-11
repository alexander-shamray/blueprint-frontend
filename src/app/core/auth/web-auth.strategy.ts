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

  /**
   * Set when `loadDiscoveryDocumentAndTryLogin()` rejects because discovery
   * itself could not be fetched (Keycloak unreachable), not because a
   * returning tryLogin() failed on a stale code (discovery succeeded in
   * that case). Read only by signIn() below, to decide whether initCodeFlow()
   * has an authorization endpoint to navigate to. This is deliberately not a
   * signal: nothing renders it, it is consulted once per signIn() call, and
   * the existing signals on this class (token) are reserved for state a
   * template or computed() reads.
   */
  private discoveryFailed = false;

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

    try {
      await this.oauth.loadDiscoveryDocumentAndTryLogin();
    } catch {
      // provideAppInitializer(() => inject(AuthService).initialize()) in
      // auth.providers.ts returns this promise to Angular, and a rejected
      // app initializer aborts bootstrap entirely — main.ts's
      // bootstrapApplication(...).catch((err) => console.error(err)) only
      // logs the failure, it does not recover from it, so the whole app
      // would render a blank page. That is wrong here: spec §5.1 makes the
      // product catalog the anonymous landing screen, and an identity
      // provider being unreachable must not take that down too. Leave
      // `token` at its default null (signed out) and resolve so bootstrap
      // continues into that signed-out state instead of failing outright.
      //
      // The rejection covers two different failures and they are handled
      // the same way here, but distinguished below for signIn()'s benefit:
      //   - loadDiscoveryDocument() itself rejected (network/DNS failure
      //     fetching .well-known/openid-configuration — Keycloak down).
      //   - discovery succeeded but tryLogin() rejected while processing a
      //     redirect back from Keycloak (angular-oauth2-oidc.mjs
      //     tryLoginCodeFlow: a `code_error` query param, a nonce that
      //     fails validateNonce, or getTokenFromCode() rejecting on a
      //     stale/already-used authorization code). A user in this second
      //     case just needs the signed-out screen, not a blank one.
      // OAuthService#discoveryDocumentLoaded distinguishes them: the
      // library sets it true only once loadDiscoveryDocument()'s success
      // path runs (angular-oauth2-oidc.mjs:1331, "this.discoveryDocumentLoaded
      // = true") and never clears it back to false, so it is true here
      // exactly when discovery succeeded and tryLogin was what failed.
      // Record a retry-worthy failure only for the discovery case — the
      // tryLogin case has an authorization endpoint waiting for signIn()
      // already.
      const discoverySucceeded = this.oauth.discoveryDocumentLoaded;
      this.discoveryFailed = !discoverySucceeded;

      if (discoverySucceeded) {
        // Only the tryLogin branch can have left a token behind:
        // fetchAndProcessToken (angular-oauth2-oidc.mjs:2249-2300) calls
        // storeAccessTokenResponse(), which writes access_token to
        // OAuthService's storage, BEFORE it awaits processIdToken() a few
        // lines later — so an id_token that fails validation rejects
        // tryLoginCodeFlow with an access_token already sitting in storage
        // that this strategy never saw and `token` (still null here) says
        // does not exist. (When discovery itself failed instead, tryLogin
        // never ran at all — loadDiscoveryDocumentAndTryLogin is
        // `loadDiscoveryDocument().then(() => tryLogin())`, so a rejected
        // loadDiscoveryDocument() skips the .then() entirely — and this
        // is also a fresh HybridOAuthStorage from this same call, so
        // there is nothing of this run's to clean up.) logOut(true) — the
        // boolean overload sets noRedirectToLogoutUrl and returns before
        // any navigation — clears every token/session key including that
        // stray access_token, making the two states agree again rather
        // than merely leaving the disagreement harmless. It also clears
        // PKCE_verifier and nonce, which is correct here too: the
        // authorization code that produced this failure is spent, and
        // signIn() mints a fresh verifier on its next initCodeFlow().
        this.oauth.logOut(true);
      }
      return;
    }

    const token = this.oauth.getAccessToken();
    if (token) this.adopt(token);
  }

  async signIn(): Promise<void> {
    if (this.discoveryFailed) {
      // initCodeFlow() (angular-oauth2-oidc.mjs:2899-2907) navigates to
      // `this.oauth`'s `loginUrl`, which loadDiscoveryDocument() populates
      // from the discovery document's authorization_endpoint
      // (angular-oauth2-oidc.mjs:1321). If discovery never succeeded,
      // loginUrl is still its initial '' and initCodeFlow() takes its other
      // branch instead of navigating: it subscribes to a
      // 'discovery_document_loaded' event and returns immediately, having
      // done nothing — and because discovery already failed once, nothing
      // will ever fire that event. Without this retry, signIn() would be a
      // button that silently does nothing forever, which is a worse bug
      // than the blank-app one this file was written to fix. Retry
      // discovery here instead: if the identity provider is back, the
      // retry succeeds and initCodeFlow() below has a real endpoint to
      // navigate to; if it is still unreachable, this await rejects and
      // that rejection propagates out of signIn() uncaught — visible to
      // the caller rather than swallowed. Both call sites take it from
      // there: `AccountPage.signOut()`'s sibling `signIn()` and
      // `CartPage.getQuote()`'s sign-in retry each `.catch()` it and render
      // a banner. That division is deliberate and not a leftover — this
      // class cannot show an error without inventing UI state it has no
      // business owning, so the one thing it can do honestly is refuse to
      // swallow the rejection.
      await this.oauth.loadDiscoveryDocument();
      this.discoveryFailed = false;
    }
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
