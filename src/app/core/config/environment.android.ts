import type { Environment } from './environment.model';

/**
 * The Android emulator's view of a stack running on the host (plan Task 20).
 *
 * `localhost` inside the emulator is the emulator, not the machine hosting
 * Keycloak and the gateway — the emulator reaches its host at the fixed alias
 * `10.0.2.2`. Every other value is `environment.development.ts`'s, because
 * only the host's address changes; a packaged build talking to a deployed
 * stack uses `environment.ts` like any other release.
 *
 * Two things must be true on the host side before this configuration works,
 * and neither is something this file can arrange:
 *
 * 1. The gateway must admit the packaged app's origin. A Capacitor build is
 *    served from `https://localhost` on Android, which is NOT the dev
 *    server's `http://localhost:5173` and is not in the backend's
 *    `Cors__Origins__*` list. See docs/client-architecture.md, "A packaged
 *    native build is a different origin".
 * 2. Keycloak must be reachable at the issuer below from inside the
 *    emulator, which for the Compose stack means the host's 8080 is
 *    published — it is — and that the realm's `mobile-app` client keeps
 *    `blueprint://auth/callback` as its redirect URI, which does not depend
 *    on the host address at all.
 *
 * Selected with `ng build --configuration android` (angular.json), not by
 * anything at runtime: which environment file a build carries is a build-time
 * replacement, and a client that sniffed its own host would be deciding its
 * configuration from the thing the configuration is supposed to decide.
 */
export const environment: Environment = {
  production: false,
  gatewayBaseUrl: 'http://10.0.2.2:5000',
  auth: {
    issuer: 'http://10.0.2.2:8080/realms/commerce',
    webClientId: 'web-app',
    nativeClientId: 'mobile-app',
    // Unused on a device — the factory in auth.providers.ts picks the native
    // strategy there, and it reads nativeRedirectUri. Present because the
    // Environment interface is one shape for both platforms, and pointed at
    // the emulator's host alias rather than at a `localhost` that would mean
    // the emulator itself if anything ever did read it.
    redirectUri: 'http://10.0.2.2:5173/',
    nativeRedirectUri: 'blueprint://auth/callback',
    scope: 'openid profile email commerce-api',
  },
};
