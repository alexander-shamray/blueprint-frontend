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
  // `{ disableBackButtonHandler?: boolean }`, and the only `launchUrl` in any
  // Capacitor source is `CustomTabsIntent.launchUrl` in the Browser plugin,
  // which is an Android API call rather than a key anything looks up. It was
  // inert config that read as load-bearing, and
  // §15 counted it as one of the places a scheme change has to visit. What
  // actually hands the return to this app is the AndroidManifest intent filter
  // and Info.plist's CFBundleURLTypes; what sends the URI is
  // `environment.auth.nativeRedirectUri`.
  //
  // It was not ignored on the way to the device, which is what made it worth
  // removing rather than leaving: `cap sync` serialises whatever this object
  // holds, so the key was written into
  // `android/app/src/main/assets/capacitor.config.json` on every sync and read
  // by nothing at the other end. Measured both ways — with the key restored the
  // generated file carries a `plugins.App.launchUrl`, and without it the file
  // has three entries and no `plugins` at all.
  //
  // It survived because the Capacitor CLI only TRANSPILES this file, so a key
  // nothing reads and a key that compiles look identical to `cap sync`.
  // `webview-origin.spec.ts` imports this module, which put it in a
  // type-checked program for the first time and is what surfaced the key: the
  // error is TS2353, excess property in an object literal. `PluginsConfig`
  // does carry an open index signature, and on its own that would have taken
  // `launchUrl` without complaint — what rejects it is `@capacitor/app`'s own
  // module augmentation declaring `App` as a NAMED property, which wins over
  // the index signature for that key. The check is real but it is the App
  // plugin's to make; a plugin that augmented nothing would still admit
  // anything.
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
