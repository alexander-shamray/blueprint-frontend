/**
 * The scenarios, one failure each that the app documents a response to.
 * README.md beside this file owns how the set was chosen and what each proves.
 */
import type { Locator, Page } from '@playwright/test';
import { APP, GATEWAY, KEYCLOAK, type Observation, type Scenario, type World } from './harness.ts';

const CATALOG = `${GATEWAY}/api/v1/catalog/products?limit=1`;
const DISCOVERY = `${KEYCLOAK}/realms/commerce/.well-known/openid-configuration`;

/** The error banner a page renders, scoped to that page: Ionic keeps every tab root mounted. */
function banner(page: Page, host: string): Locator {
  return page.locator(`${host} app-error-banner [role="alert"]`);
}

/** The banner's kind, as `ErrorBannerComponent` writes it into `data-kind`. */
async function bannerKind(page: Page, host: string): Promise<string | null> {
  const found = banner(page, host);
  return (await found.count()) > 0 ? found.first().getAttribute('data-kind') : null;
}

async function bannerIs(page: Page, host: string, kinds: readonly string[]): Promise<Observation> {
  const kind = await bannerKind(page, host);
  return [kind !== null && kinds.includes(kind), `${host}'s banner is ${kind ?? 'absent'}`];
}

/** Rows or the empty state, and no banner: the list loaded and said what it holds. */
async function listLoaded(page: Page): Promise<Observation> {
  const rows = await page.locator('app-products ion-list ion-item').count();
  const empty = await page.locator('app-products app-empty-state').count();
  const kind = await bannerKind(page, 'app-products');
  return [
    (rows > 0 || empty > 0) && kind === null,
    `${rows} rows, ${empty} empty states, banner ${kind ?? 'absent'}`,
  ];
}

async function openProducts(world: World): Promise<void> {
  await world.page.goto(`${APP}/tabs/products`);
}

/** The way back the products page offers after a failed load: its Try again button. */
async function tryAgainLoads(world: World): Promise<Observation> {
  const again = world.page.locator('app-products').getByRole('button', { name: 'Try again' });
  if ((await again.count()) > 0) await again.first().click();
  return listLoaded(world.page);
}

/**
 * A stopped or paused service the products page reads through, and how the
 * page answers it. The cause reloads the page: a user opening the app while
 * the backend is broken.
 */
function catalogOutage(options: {
  readonly name: string;
  readonly service: string;
  readonly how: 'stop' | 'pause';
  readonly kinds: readonly string[];
  readonly promise: string;
  readonly source: string;
  readonly deadlineSeconds: number;
  readonly ready: string;
}): Scenario {
  return {
    name: options.name,
    impact: 'outage',
    promise: options.promise,
    source: options.source,
    services: [options.service],
    deadlineSeconds: options.deadlineSeconds,
    settleSeconds: 180,
    prepare: openProducts,
    async cause(world) {
      if (options.how === 'stop') await world.compose.stop(options.service);
      else await world.compose.pause(options.service);
      world.say(`${options.service}: ${options.how === 'stop' ? 'stopped' : 'paused'}`);
      await world.page.reload();
    },
    check: (world) => bannerIs(world.page, 'app-products', options.kinds),
    async restore(world) {
      // Read from the stack, not from this process: a paused container
      // refuses `start`, and a running one refuses `unpause`.
      if ((await world.compose.state(options.service)) === 'paused') {
        await world.compose.unpause(options.service);
      }
      await world.compose.start(options.service);
    },
    settled: (world) => world.probe(options.ready),
    recovered: tryAgainLoads,
  };
}

const gatewayDown = catalogOutage({
  name: 'gateway-down',
  service: 'gateway',
  how: 'stop',
  kinds: ['retry'],
  promise:
    'with the gateway unreachable (status 0), the product list shows the retry banner and a Try again button that loads it once the gateway is back',
  source: 'src/app/core/errors/error-mapper.ts:174',
  deadlineSeconds: 30,
  ready: `${GATEWAY}/health/ready`,
});

const catalogDown = catalogOutage({
  name: 'catalog-down',
  service: 'catalog-api',
  how: 'stop',
  kinds: ['unavailable', 'retry'],
  promise:
    "with the catalog stopped behind the gateway, the gateway's 5xx is a banner (503 the unavailable one, any other the retry one) and Try again loads the list once it is back",
  source: 'src/app/core/errors/error-mapper.ts:170',
  deadlineSeconds: 60,
  ready: CATALOG,
});

const catalogSlow = catalogOutage({
  name: 'catalog-slow',
  service: 'catalog-api',
  how: 'pause',
  kinds: ['retry'],
  promise:
    "with the catalog paused, the gateway's deadline answers 504 and the list shows the retry banner rather than hanging; nothing retries on its own",
  source: 'src/app/core/errors/error-mapper.ts:174',
  deadlineSeconds: 90,
  ready: CATALOG,
});

const keycloakDown: Scenario = {
  name: 'keycloak-down',
  impact: 'outage',
  promise:
    'with Keycloak unreachable, Sign in on the Account tab stays in the app and shows an error banner instead of a button that does nothing',
  source: 'src/app/features/account/account.page.ts:563',
  services: ['keycloak'],
  deadlineSeconds: 90,
  settleSeconds: 240,
  async prepare() {
    // Nothing: the app is opened after the cause, as a user opening it while
    // Keycloak is down, so no discovery document is already held.
  },
  async cause(world) {
    await world.compose.stop('keycloak');
    world.say('keycloak: stopped');
    await world.page.goto(`${APP}/tabs/account`);
    await world.page.getByRole('button', { name: 'Sign in' }).click();
  },
  async check(world) {
    const [shown, observed] = await bannerIs(world.page, 'app-account', [
      'retry',
      'unavailable',
      'signIn',
    ]);
    const url = world.page.url();
    const stayed = url.startsWith(APP);
    return [shown && stayed, `${observed}; the page is at ${url}`];
  },
  async restore(world) {
    await world.compose.start('keycloak');
  },
  settled: (world) => world.probe(DISCOVERY),
  async recovered(world) {
    // Pressed once per poll until the button leaves for Keycloak's own page.
    const button = world.page.locator('app-account').getByRole('button', { name: 'Sign in' });
    if (world.page.url().startsWith(KEYCLOAK)) return [true, 'Sign in reached Keycloak'];
    if ((await button.count()) > 0) await button.first().click();
    return [world.page.url().startsWith(KEYCLOAK), `the page is at ${world.page.url()}`];
  },
};

const offline: Scenario = {
  name: 'offline',
  impact: 'browser',
  promise:
    'offline, the shell shows the offline banner and a loaded list says it is stale; back online, both go',
  source: 'src/app/shared/offline-banner.component.ts:19',
  services: [],
  deadlineSeconds: 15,
  settleSeconds: 15,
  prepare: openProducts,
  async cause(world) {
    await world.context.setOffline(true);
    world.say('the browser context is offline');
  },
  async check(world) {
    const shown = await world.page.locator('[data-testid="offline-banner"]').count();
    const rows = await world.page.locator('app-products ion-list ion-item').count();
    const stale = await world.page.locator('app-products [data-testid="stale-list"]').count();
    // The stale line is promised only over a list that holds rows
    // (products.page.ts's `stale`), and a fresh stack's catalogue is empty.
    const staleHolds = rows === 0 || stale > 0;
    return [shown > 0 && staleHolds, `offline banner ${shown}, rows ${rows}, stale line ${stale}`];
  },
  async restore(world) {
    await world.context.setOffline(false);
  },
  async settled() {
    return [true, 'the context is online'];
  },
  async recovered(world) {
    const shown = await world.page.locator('[data-testid="offline-banner"]').count();
    const stale = await world.page.locator('app-products [data-testid="stale-list"]').count();
    return [shown === 0 && stale === 0, `offline banner ${shown}, stale line ${stale}`];
  },
};

export const SCENARIOS: readonly Scenario[] = [
  gatewayDown,
  catalogDown,
  catalogSlow,
  keycloakDown,
  offline,
];

/**
 * Failures the issue asks after that no scenario causes yet, each with why. A
 * failure is either above or here, and the suite holds that.
 */
export const NOT_CAUSED: Readonly<Record<string, string>> = {
  'session-expired':
    'the web realm issues no refresh token and the access token lives for the realm\'s lifespan (spec §5.6); causing a 401 mid-use means changing a realm setting the backend owns',
  'session-revoked':
    'a revoked session only reaches the client as a 401 if the gateway checks the session rather than the token\'s signature and expiry, which is the backend\'s to say',
};
