import type { Environment } from './environment.model';

/**
 * Every value here is read from the backend's Compose stack rather than chosen:
 * - gateway 5000       deploy/compose/services/gateway.yml:34
 * - Keycloak 8080      deploy/compose/infrastructure.yml (KC_HOSTNAME)
 * - redirect 5173      realm-export.json, web-app.redirectUris + webOrigins,
 *                      and gateway.yml:32's Cors__Origins__0
 * A client that needed any of these changed would be a client the backend has
 * to accommodate, which is backwards.
 */
export const environment: Environment = {
  production: false,
  gatewayBaseUrl: 'http://localhost:5000',
  auth: {
    issuer: 'http://localhost:8080/realms/commerce',
    webClientId: 'web-app',
    nativeClientId: 'mobile-app',
    redirectUri: 'http://localhost:5173/',
    nativeRedirectUri: 'blueprint://auth/callback',
    scope: 'openid profile email commerce-api',
  },
};
