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
  // redirectUris exactly — Keycloak compares the string.
  //
  // This is one of several independent copies, and none of them can import
  // another: `environment.auth.nativeRedirectUri` in each of the three
  // environment files (what the strategy actually sends), this `launchUrl`,
  // `android/app/src/main/AndroidManifest.xml`'s intent filter and
  // `ios/App/App/Info.plist`'s CFBundleURLTypes (what makes each OS hand the
  // return to this app), and the realm export in the backend repository. A
  // scheme change has to visit every one of them; docs/client-architecture.md
  // §15 lists them for that reason.
  plugins: {
    App: { launchUrl: 'blueprint://auth/callback' },
  },
};

export default config;
