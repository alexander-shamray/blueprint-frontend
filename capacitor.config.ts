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
  // Deliberately NOT here: the `blueprint://auth/callback` redirect URI. This
  // file carried it as `plugins.App.launchUrl`, which is not a key anything
  // reads — `@capacitor/app` declares the App plugin's whole configuration as
  // `{ disableBackButtonHandler?: boolean }` and no Capacitor source mentions
  // `launchUrl` at all. It was inert config that read as load-bearing, and
  // §15 counted it as one of the places a scheme change has to visit. What
  // actually hands the return to this app is the AndroidManifest intent filter
  // and Info.plist's CFBundleURLTypes; what sends the URI is
  // `environment.auth.nativeRedirectUri`.
  //
  // It survived because the Capacitor CLI only TRANSPILES this file — a config
  // key that types fine to `unknown` and a key nothing reads look identical to
  // `cap sync`. `webview-origin.spec.ts` imports this module, so it is now in
  // a program that type-checks, which is what surfaced it.
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
  // Deliberately NOT done here: `server.androidScheme: 'http'`. It clears
  // block 2 ONLY, and that is easy to get wrong: `androidScheme` feeds the
  // local asset server's URL and the bridge's same-origin check
  // (`Bridge.getScheme()`) and nothing else, so it cannot reach
  // `usesCleartextTraffic` or the platform's NetworkSecurityPolicy. An
  // `http://10.0.2.2` request from an `http://localhost` page is still
  // ERR_CLEARTEXT_NOT_PERMITTED and still needs `server.cleartext`. So it is
  // not the one-key alternative it looks like: it trades `allowMixedContent`
  // for a change to the origin the gateway and the realm each have to admit.
  // The realm admits `https://localhost` and `capacitor://localhost` by name
  // now (#6), so moving the Android origin to `http://localhost` would revoke
  // a grant that stayed exactly where it was, silently — the token exchange is
  // a browser `fetch` and CORS is what answers it. `webview-origin.spec.ts`
  // fails on that edit, for the emulator sync and the release one alike. One
  // origin for every build is worth more than one fewer key here.
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
