import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Whether this sync is for the Android emulator talking to a Compose stack on
 * the developer's own machine, rather than for a build that talks to a
 * deployed one (issue #7, plan Task 20).
 *
 * `capacitor.config.ts` is one committed file for every build and the
 * Capacitor CLI has no `--config` answer to Angular's `fileReplacements`, so
 * the only place a per-build switch can come from is the environment of the
 * process that runs `cap sync`. `npm run emulator:android` is the supported
 * way to set it; the script is matched by NAME rather than exporting a
 * variable because `BLUEPRINT_EMULATOR=1 cap sync` is not a line cmd.exe
 * runs, and adding `cross-env` for one boolean is a dependency for nothing.
 * The variable is honoured as well, for a shell or a CI job that would rather
 * say it outright.
 *
 * The direction of the default is the point: a sync nobody flagged produces a
 * build with none of the relaxations below, so the way to ship cleartext by
 * accident is to ask for it.
 */
const emulator =
  process.env['BLUEPRINT_EMULATOR'] === '1' ||
  process.env['npm_lifecycle_event'] === 'emulator:android';

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
  // Reaching the host from the emulator over plain HTTP is blocked TWICE, and
  // each block has its own key — setting either one alone changes nothing,
  // which is why issue #7's `server.cleartext` was half a fix:
  //
  // 1. `server.cleartext` writes `android:usesCleartextTraffic="true"` into
  //    `android/capacitor-cordova-android-plugins`' manifest, which the
  //    manifest merger folds into the app's. Without it the PLATFORM refuses
  //    cleartext outright — off by default from API 28, and
  //    `android/variables.gradle` targets 36.
  // 2. `android.allowMixedContent` puts the WebView into
  //    MIXED_CONTENT_ALWAYS_ALLOW (`Bridge.initWebView`). Without it the
  //    PAGE, served from `https://localhost`, may not fetch an `http://`
  //    subresource — which is every gateway and Keycloak call
  //    `environment.android.ts` names.
  //
  // Capacitor's own declarations call both "not intended for use in
  // production". That is exactly why they hang off `emulator` rather than
  // being written flat, and why the ci `android` job asserts a release sync
  // produces neither.
  //
  // Deliberately NOT done here: `server.androidScheme: 'http'`. It would
  // clear both blocks at once, and `http://localhost` is still a secure
  // context so `crypto.subtle` keeps minting the S256 challenge — but it
  // changes the origin the gateway and the realm each have to admit, and
  // those two origins are the whole of #6 and half of §15. One origin for
  // every build is worth more than one fewer key here.
  //
  // iOS is untouched: the simulator reaches the host at `localhost` with no
  // alias, and its cleartext question is App Transport Security in
  // Info.plist, not either key above.
  ...(emulator
    ? {
        server: { cleartext: true },
        android: { allowMixedContent: true },
      }
    : {}),
};

export default config;
