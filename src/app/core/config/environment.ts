import type { Environment } from './environment.model';

export const environment: Environment = {
  production: true,
  gatewayBaseUrl: 'https://gateway.example.invalid',
  auth: {
    issuer: 'https://keycloak.example.invalid/realms/commerce',
    webClientId: 'web-app',
    nativeClientId: 'mobile-app',
    redirectUri: 'https://app.example.invalid/',
    nativeRedirectUri: 'blueprint://auth/callback',
    scope: 'openid profile email commerce-api',
  },
};
