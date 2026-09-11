/**
 * The client's whole configuration surface. Two clients and one authority,
 * because the realm has two clients and one authority
 * (deploy/compose/keycloak/realm-export.json): `web-app` for the browser,
 * `mobile-app` for Android and iOS. Which one is used is decided once, by the
 * factory in core/auth/auth.providers.ts, and nowhere else (spec §4).
 */
export interface Environment {
  readonly production: boolean;

  /** The gateway is the only host the client calls for platform data (spec §2). */
  readonly gatewayBaseUrl: string;

  readonly auth: {
    /** Keycloak realm URL. Must match the `iss` claim the realm mints. */
    readonly issuer: string;
    /** Realm client `web-app`: public, PKCE S256, no refresh token. */
    readonly webClientId: string;
    /** Realm client `mobile-app`: public, PKCE S256, rotating refresh token. */
    readonly nativeClientId: string;
    /** Browser redirect. Must appear in the realm client's `redirectUris`. */
    readonly redirectUri: string;
    /** Custom scheme the system browser returns to on native (spec §4.2). */
    readonly nativeRedirectUri: string;
    /**
     * `commerce-api` carries the audience mapper and the `permission` claim
     * mapper; without it the token is refused by every service.
     */
    readonly scope: string;
  };
}
