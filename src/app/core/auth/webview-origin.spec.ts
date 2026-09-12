import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapacitorConfig } from '@capacitor/cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #6: the token exchange is a browser `fetch`, and the realm has to
 * grant the origin it comes from.
 *
 * `native-auth.strategy.ts` posts the authorization code to Keycloak's token
 * endpoint with `fetch`. On a device that is a cross-origin request from the
 * WebView's own loopback origin, so the `mobile-app` client's `webOrigins` is
 * what decides whether the WebView may READ the answer. It now grants two
 * (`deploy/compose/keycloak/realm-export.json`, backend repository):
 *
 *     "webOrigins": [ "https://localhost", "capacitor://localhost" ]
 *
 * and the backend's realm gate (`deploy/keycloak/realm_check.py`,
 * `check_web_origins`) asserts the OBLIGATION — granted, non-empty, no
 * wildcard, every entry a real browser origin — while deliberately declining
 * to assert the VALUES, because what a packaged app's origin actually is comes
 * out of `capacitor.config.ts` in THIS repository. Pinning literals there would
 * fail a realm that had been corrected rather than one that had drifted. So the
 * contract has two halves in two repositories and neither can see the other.
 * This file is this half.
 *
 * The failure it guards is silent on both sides, which is why it is worth a
 * test that runs on every push rather than a line in a document.
 * `application/x-www-form-urlencoded` is CORS-safelisted and a public client
 * sends no `Authorization` header, so there is no preflight to fail: the
 * request goes out, Keycloak mints a token, and the browser discards the
 * response for want of a matching `Access-Control-Allow-Origin`. The
 * authorization code is spent, `fetch` rejects with a `TypeError`, `post()`
 * reports `unreachable`, and CI stays green. Every one of the strategy's own
 * unit tests injects a `fetch` mock, which is precisely the layer that cannot
 * observe a browser refusing to hand over a real response.
 */

/** The two entries the `mobile-app` client grants, in the order it lists them. */
const ANDROID_ORIGIN = 'https://localhost';
const IOS_ORIGIN = 'capacitor://localhost';

/**
 * Reads one default out of the installed native platform's own source.
 *
 * Three of the four fields that decide the origin are usually absent from
 * `capacitor.config.ts` — the origin comes from a default held in Java and
 * Swift. Writing those defaults here as literals would make this suite agree
 * with itself: a Capacitor major that moved one would move this app's origin
 * off a grant that stayed exactly where it was, and nothing would say so. The
 * platform packages are in `node_modules`, so the real values are readable,
 * and `package.json` pins Capacitor to an exact version — an upgrade is a
 * commit, and this asserts against whatever that commit installed.
 *
 * Every way of not finding a value THROWS rather than falling back. A guard
 * that silently substituted its own assumption for a default it could no
 * longer locate would keep passing at exactly the moment it stopped meaning
 * anything.
 */
function platformDefault(relativePath: string, pattern: RegExp, what: string): string {
  const file = join(process.cwd(), 'node_modules', relativePath);
  const values = [...readFileSync(file, 'utf8').matchAll(pattern)].map((match) => match[1]);

  if (values.length === 0) {
    throw new Error(
      `Could not read ${what} from ${relativePath}. Capacitor moved or renamed it, ` +
        `which means the WebView origin this app is served from may have moved too — ` +
        `check it against the mobile-app client's webOrigins before updating this pattern.`,
    );
  }

  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(
      `Found ${distinct.length} different values for ${what} in ${relativePath}: ` +
        `${distinct.join(', ')}. Which one applies is no longer decidable from the source.`,
    );
  }

  return distinct[0];
}

const ANDROID = 'capacitor/src/main/java/com/getcapacitor';
const IOS = 'Capacitor/Capacitor/CAPInstanceDescriptor.swift';

/**
 * Android's default scheme, resolved through the constant `CapConfig` names
 * rather than read off it.
 *
 * `CapConfig` initialises `androidScheme` to `CAPACITOR_HTTPS_SCHEME` and
 * `Bridge` declares what that is. Both halves are checked, because reading
 * only the constant would miss a `CapConfig` that had been changed to
 * initialise from the `http` one beside it, and reading only the initialiser
 * would give a symbol rather than a scheme.
 */
function androidDefaultScheme(): string {
  const constant = platformDefault(
    `@capacitor/android/${ANDROID}/CapConfig.java`,
    /private String androidScheme = (\w+);/g,
    "CapConfig's default androidScheme",
  );

  return platformDefault(
    `@capacitor/android/${ANDROID}/Bridge.java`,
    new RegExp(`public static final String ${constant} = "([^"]+)";`, 'g'),
    `the value of Bridge.${constant}`,
  );
}

const PLATFORM_DEFAULTS = {
  android: {
    scheme: androidDefaultScheme(),
    hostname: platformDefault(
      `@capacitor/android/${ANDROID}/CapConfig.java`,
      /private String hostname = "([^"]+)";/g,
      "CapConfig's default hostname",
    ),
  },
  ios: {
    scheme: platformDefault(
      `@capacitor/ios/${IOS}`,
      /public static let scheme = "([^"]+)"/g,
      "CAPInstanceDescriptor's default scheme",
    ),
    hostname: platformDefault(
      `@capacitor/ios/${IOS}`,
      /public static let hostname = "([^"]+)"/g,
      "CAPInstanceDescriptor's default hostname",
    ),
  },
} as const;

/**
 * Loads the real root `capacitor.config.ts` under a chosen sync environment.
 *
 * The module reads `process.env` at load time — that is the whole mechanism of
 * the emulator gate — so the environment has to be set before the import and
 * the module registry reset between loads. `npm_lifecycle_event` is `test`
 * when this suite runs under `npm test`, but a run through some other script
 * name would set something else, so both selectors are pinned explicitly
 * rather than assumed absent.
 */
async function loadConfig(env: Record<string, string>): Promise<CapacitorConfig> {
  process.env['BLUEPRINT_EMULATOR'] = env['BLUEPRINT_EMULATOR'] ?? '';
  process.env['npm_lifecycle_event'] = env['npm_lifecycle_event'] ?? '';
  vi.resetModules();
  return (await import('../../../../capacitor.config')).default;
}

/**
 * The origin a WebView loading this config asks to be served from.
 *
 * Four fields move it, and each is a way to revoke the realm's grant without
 * touching the realm: `server.url` replaces the local asset server outright
 * (live reload), while `hostname` and the two scheme keys each override one
 * half of the platform default above. Android narrows this a little at
 * runtime — `CapConfig.validateScheme` accepts `http` and `https` and ignores
 * anything else — which is a reason there are fewer ways to get it wrong, not
 * a reason to stop checking.
 */
function webViewOrigin(config: CapacitorConfig, platform: 'android' | 'ios'): string {
  const server = config.server ?? {};
  if (server.url !== undefined) {
    return new URL(server.url).origin;
  }

  const defaults = PLATFORM_DEFAULTS[platform];
  const declared = platform === 'android' ? server.androidScheme : server.iosScheme;

  return `${declared ?? defaults.scheme}://${server.hostname ?? defaults.hostname}`;
}

/**
 * `webViewOrigin` is the model, and the suite below is only as good as it.
 *
 * Every assertion further down runs against the real config, which overrides
 * none of the four fields — so those branches are never taken, and a
 * `webViewOrigin` that had quietly stopped reading one would keep this file
 * green while the guard it implements was dead. That is the failure this
 * describe block exists to make impossible: it drives each branch with a
 * synthetic config, so the model is pinned before it is trusted.
 *
 * The expected values are the ones Capacitor's own resolution produces, not
 * this function's: an `http` android scheme serves the page from
 * `http://localhost`, a `hostname` moves BOTH platforms because one field
 * feeds both, and `server.url` replaces the whole origin rather than a part
 * of it.
 */
describe('the origin a config asks for', () => {
  it('honours an explicit Android scheme', () => {
    const config: CapacitorConfig = { server: { androidScheme: 'http' } };

    expect(webViewOrigin(config, 'android')).toBe('http://localhost');
    expect(webViewOrigin(config, 'ios')).toBe(IOS_ORIGIN);
  });

  it('honours an explicit iOS scheme', () => {
    const config: CapacitorConfig = { server: { iosScheme: 'ionic' } };

    expect(webViewOrigin(config, 'ios')).toBe('ionic://localhost');
    expect(webViewOrigin(config, 'android')).toBe(ANDROID_ORIGIN);
  });

  it('honours a hostname, and it moves both platforms', () => {
    const config: CapacitorConfig = { server: { hostname: '10.0.2.2' } };

    expect(webViewOrigin(config, 'android')).toBe('https://10.0.2.2');
    expect(webViewOrigin(config, 'ios')).toBe('capacitor://10.0.2.2');
  });

  it('honours a live-reload server.url on both platforms', () => {
    const config: CapacitorConfig = { server: { url: 'http://10.0.2.2:5173' } };

    expect(webViewOrigin(config, 'android')).toBe('http://10.0.2.2:5173');
    expect(webViewOrigin(config, 'ios')).toBe('http://10.0.2.2:5173');
  });

  /**
   * `server.url` is the WebView's whole origin when it is set, so the scheme
   * and hostname keys beside it decide nothing. Asserting the precedence
   * keeps a model that merely happened to read `url` first from passing as
   * one that reads it instead.
   */
  it('lets server.url override the scheme and hostname beside it', () => {
    const config: CapacitorConfig = {
      server: {
        url: 'https://reload.example:8100',
        androidScheme: 'http',
        iosScheme: 'ionic',
        hostname: '10.0.2.2',
      },
    };

    expect(webViewOrigin(config, 'android')).toBe('https://reload.example:8100');
    expect(webViewOrigin(config, 'ios')).toBe('https://reload.example:8100');
  });

  it('falls back to the platform defaults when the config overrides nothing', () => {
    expect(webViewOrigin({}, 'android')).toBe(ANDROID_ORIGIN);
    expect(webViewOrigin({}, 'ios')).toBe(IOS_ORIGIN);
  });
});

describe('the WebView origin the realm grants', () => {
  const lifecycle = process.env['npm_lifecycle_event'];
  const emulator = process.env['BLUEPRINT_EMULATOR'];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env['npm_lifecycle_event'] = lifecycle ?? '';
    process.env['BLUEPRINT_EMULATOR'] = emulator ?? '';
    vi.resetModules();
  });

  it('a release sync serves Android from the origin mobile-app grants', async () => {
    expect(webViewOrigin(await loadConfig({}), 'android')).toBe(ANDROID_ORIGIN);
  });

  it('a release sync serves iOS from the origin mobile-app grants', async () => {
    expect(webViewOrigin(await loadConfig({}), 'ios')).toBe(IOS_ORIGIN);
  });

  /**
   * The emulator sync is where this is most likely to be lost, and to a change
   * that reads like a simplification. `server.androidScheme: 'http'` looks like
   * a one-key replacement for the cleartext pair those flags set (§15 says why
   * it is not), and it would move the Android origin to `http://localhost` —
   * which the realm does not grant and which nothing else here would notice.
   */
  it('the emulator relaxations move neither origin', async () => {
    const flagged = await loadConfig({ BLUEPRINT_EMULATOR: '1' });

    expect(webViewOrigin(flagged, 'android')).toBe(ANDROID_ORIGIN);
    expect(webViewOrigin(flagged, 'ios')).toBe(IOS_ORIGIN);
  });

  it('the documented emulator script moves neither origin', async () => {
    const flagged = await loadConfig({ npm_lifecycle_event: 'emulator:android' });

    expect(webViewOrigin(flagged, 'android')).toBe(ANDROID_ORIGIN);
    expect(webViewOrigin(flagged, 'ios')).toBe(IOS_ORIGIN);
  });

  /**
   * Android and iOS differ by scheme and NOT by host: one `hostname` feeds
   * both, so an edit there is the single change that revokes both grants at
   * once. Asserting the pair stays distinct keeps the assertions above from
   * being satisfiable by a config that had collapsed them onto one origin.
   */
  it('the two platforms are two origins, not one', async () => {
    const config = await loadConfig({});

    expect(webViewOrigin(config, 'android')).not.toBe(webViewOrigin(config, 'ios'));
  });
});
