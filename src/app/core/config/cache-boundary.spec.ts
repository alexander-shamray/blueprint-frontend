import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #99, `docs/client-architecture.md` §16: the service worker caches the shell
 * and nothing else, and these cases hold that boundary where a later edit
 * would move it. The subject is what the worker is *allowed to see*, not what
 * a build produced: `src/ngsw-config.json` is read as data, and every pattern
 * in it is run against the URLs that must never be cached.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = <T>(path: string) => JSON.parse(read(path)) as T;

interface NgswConfig {
  assetGroups: { resources: { files?: string[]; urls?: string[] } }[];
  navigationUrls: string[];
}
interface Manifest {
  theme_color: string;
  start_url: string;
  display: string;
  icons: { src: string; purpose: string }[];
}
interface AngularJson {
  projects: {
    'blueprint-frontend': {
      architect: { build: { configurations: Record<string, { serviceWorker?: string }> } };
    };
  };
}

/** Angular's ngsw glob subset, enough for the patterns this repository writes. */
function matches(pattern: string, url: string): boolean {
  const source = pattern
    .replace(/[.+^${}[\]\\]/g, '\\$&')
    .split('**')
    .map((part) => part.replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(url);
}

/** What the worker must never answer from cache: the platform, and the identity provider's round trip. */
const NEVER_CACHED = [
  '/api/v1/catalog/products',
  '/api/v1/orders',
  '/silent-refresh.html',
  '/.well-known/openid-configuration',
];

const config = json<NgswConfig>('src/ngsw-config.json');
const patterns = config.assetGroups.flatMap((group) => group.resources.files ?? []);

describe('the service worker caches the shell and nothing else (#99)', () => {
  it('is not asked to cache any API response: no data groups', () => {
    expect(config).not.toHaveProperty('dataGroups');
  });

  it('is not asked to cache any other origin: no asset group lists URLs', () => {
    for (const group of config.assetGroups) {
      expect(group.resources).not.toHaveProperty('urls');
    }
  });

  it('matches no file pattern against the platform or the identity round trip', () => {
    for (const url of NEVER_CACHED) {
      for (const pattern of patterns) {
        expect(matches(pattern, url), `${pattern} matches ${url}`).toBe(false);
      }
    }
  });

  it('is not vacuous: the glob reader matches the shell it is meant to match', () => {
    expect(patterns.some((pattern) => matches(pattern, '/main-ABC123.js'))).toBe(true);
    expect(patterns.some((pattern) => matches(pattern, '/styles-XYZ789.css'))).toBe(true);
    expect(patterns.some((pattern) => matches(pattern, '/index.html'))).toBe(true);
    expect(matches('/*.js', '/api/v1/x.js')).toBe(false);
  });

  it('never answers the identity provider’s iframe or the API with the shell', () => {
    const navigation = config.navigationUrls;
    expect(navigation).toContain('!/silent-refresh.html');
    expect(navigation).toContain('!/api/**');
  });

  it('registers the worker only outside development and native builds', () => {
    const appConfig = read('src/app/app.config.ts');
    expect(appConfig).toContain(
      'enabled: serviceWorkerEnabled(isDevMode(), Capacitor.isNativePlatform())',
    );
  });

  it('puts the worker in the production build and in no other configuration', () => {
    const { configurations } =
      json<AngularJson>('angular.json').projects['blueprint-frontend'].architect.build;

    expect(configurations['production'].serviceWorker).toBe('src/ngsw-config.json');
    for (const name of Object.keys(configurations).filter((n) => n !== 'production')) {
      expect(configurations[name], `${name} configuration`).not.toHaveProperty('serviceWorker');
    }
  });
});

describe('the web build is installable (#99)', () => {
  const manifest = json<Manifest>('public/manifest.webmanifest');

  it('is linked from the page, with a theme colour for each scheme', () => {
    const html = read('src/index.html');
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(html).toMatch(/name="theme-color"[^>]*prefers-color-scheme: light/);
    expect(html).toMatch(/name="theme-color"[^>]*prefers-color-scheme: dark/);
  });

  it('takes its theme colour from the palette’s primary', () => {
    const primary = /--ion-color-primary:\s*(#[0-9a-f]{6})/i.exec(read('src/theme/variables.css'));
    expect(primary).not.toBeNull();
    expect(manifest.theme_color.toLowerCase()).toBe(primary?.[1].toLowerCase());
  });

  it('names icons that exist, including one a platform may mask', () => {
    expect(manifest.icons.map((icon) => icon.purpose)).toContain('maskable');
    for (const icon of manifest.icons) {
      expect(existsSync(join(root, 'public', icon.src)), icon.src).toBe(true);
    }
  });

  it('starts at the root and runs standalone', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });
});
