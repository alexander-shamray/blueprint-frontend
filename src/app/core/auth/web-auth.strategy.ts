import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { AuthConfig, MemoryStorage, OAuthService } from 'angular-oauth2-oidc';
import { environment } from '@core/config/environment';
import { AuthService, CurrentUser } from './auth.service';
import { decodeUser } from './current-user';

/**
 * The browser half of spec §4.1.
 *
 * Tokens are held in memory only — no localStorage, no sessionStorage. A page
 * reload signs the user out, and that is the honest consequence of the realm's
 * `use.refresh.tokens: "false"` on `web-app` rather than an oversight; the
 * account page says so in a sentence (spec §5.6).
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
    // In memory only. `provideOAuthClient()`'s default storage is
    // sessionStorage (falling back to an in-memory Map only when
    // sessionStorage is unavailable — see createDefaultStorage in the
    // library), which would survive a same-tab reload and contradict the
    // "reload signs you out" posture above. angular-oauth2-oidc ships its own
    // in-memory OAuthStorage precisely for this case, so it is used as-is
    // rather than hand-rolling an object cast to the browser's Storage type
    // (a cast the library's setStorage(storage: OAuthStorage) does not even
    // ask for — its parameter type is the library's own three-method
    // OAuthStorage, not the DOM Storage interface).
    this.oauth.setStorage(new MemoryStorage());

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
