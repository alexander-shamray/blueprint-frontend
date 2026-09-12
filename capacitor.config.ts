import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native shell's whole configuration. `webDir` is the Angular build's
 * browser output, which is what `cap sync` copies into the two native
 * projects; it is not a path the application itself ever reads.
 */
const config: CapacitorConfig = {
  appId: 'dev.ashamray.blueprint',
  appName: 'Blueprint',
  webDir: 'dist/blueprint-frontend/browser',
  // The custom scheme the system browser returns to after the authorization
  // code flow (spec §4.2). It must match the mobile-app realm client's
  // redirectUris exactly — Keycloak compares the string — and it must match
  // `environment.auth.nativeRedirectUri`, which is what the strategy sends.
  // Three copies of one string is two too many, but the other two live in
  // files this one cannot import: a realm export in another repository, and
  // an Android manifest that is XML.
  plugins: {
    App: { launchUrl: 'blueprint://auth/callback' },
  },
};

export default config;
