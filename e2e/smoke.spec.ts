import { expect, test } from '@playwright/test';

const GATEWAY = 'http://localhost:5000';
const KEYCLOAK = 'http://localhost:8080';

/**
 * Requires Docker and the backend checkout. Without the stack this fails on
 * connection rather than skipping — the backend's own rule is that a skip
 * fails open, and a smoke that quietly passes with nothing running is worse
 * than no smoke.
 */
test.beforeAll(async ({ request }) => {
  const health = await request.get(`${GATEWAY}/health/ready`);
  expect(
    health.ok(),
    `The gateway is not answering at ${GATEWAY}. Start the backend's Compose stack first.`,
  ).toBe(true);
});

async function signIn(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/tabs/account');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`^${KEYCLOAK}`));

  await page.getByLabel(/username|email/i).fill(username);
  // Exact match, not /password/i: Keycloak's login page renders a "Show
  // password" visibility-toggle button right next to the field, and its own
  // aria-label also contains the word "password" — a loose regex resolves to
  // both under Playwright's strict mode. This targets the field Keycloak
  // labels exactly "Password", nothing about our own app.
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  // Not necessarily /tabs/account: environment.development.ts pins the OAuth
  // redirectUri to the app's bare origin (it must appear verbatim in the
  // realm client's redirectUris), so the callback lands on '/', which
  // app.routes.ts sends to 'tabs/products' regardless of which page asked
  // for sign-in. Landing there is correct, not a bug — a page.goto() to
  // steer it would be a second full navigation, and on the web this realm
  // issues no refresh token (spec §5.6), so that reload would end the
  // session this helper just established. A tab click is an in-app
  // navigation and does not reload.
  await page.waitForURL(/localhost:5173/);
  await page.getByRole('tab', { name: 'Account' }).click();
}

/**
 * Publishes a product through the UI and returns its name.
 *
 * The catalogue starts EMPTY on a clean stack, and nothing else in this suite
 * puts anything in it that the order test can rely on. A developer's machine
 * hides that: it accumulates products from every previous run and every manual
 * check, so `getByRole('button', { name: 'Add' })` always found something
 * locally. On CI's fresh Compose stack it found nothing, and the order test
 * failed at its first assertion — before it could even reach the step that was
 * already known to be blocked locally.
 *
 * So a test that needs products creates them. `demo` holds `catalog:write`,
 * which is the whole reason that realm user exists.
 */
async function publishProduct(page: import('@playwright/test').Page, amount: string) {
  const name = `Smoke ${amount} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await page.getByRole('tab', { name: 'Publish' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Currency').fill('EUR');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published as')).toBeVisible();

  return name;
}

test('demo browses, quotes, orders and cancels', async ({ page }) => {
  await signIn(page, 'demo', 'demo');

  await expect(page.getByText('demo')).toBeVisible();
  await expect(page.getByText('catalog:write')).toBeVisible();

  // Two products, in EUR, because the quote below asks for EUR and a product
  // priced in another currency comes back in `Unpriced` rather than as a line.
  await publishProduct(page, '12.50');
  await publishProduct(page, '4.00');

  // Browse a page of products and add two.
  await page.getByRole('tab', { name: 'Products' }).click();
  const addButtons = page.getByRole('button', { name: 'Add' });
  await expect(addButtons.first()).toBeVisible();
  await addButtons.nth(0).click();
  await addButtons.nth(1).click();

  // Quote.
  await page.getByRole('tab', { name: 'Cart' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  // The basket, and labelled as one. The quote POSTs the cart's quantities and
  // CheckoutEndpoints.cs totals the line totals, so "Total:" is a true
  // statement about the customer's basket — which it was not under the old
  // GET, where this line had to look for "Quoted unit prices:" instead
  // (ADR-045).
  await expect(page.getByText(/Total:/)).toBeVisible();

  // Place.
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Line 1').fill('1 Example Street');
  await page.getByLabel('City').fill('Doha');
  await page.getByLabel('Postal code').fill('00000');
  await page.getByLabel('Country').fill('QA');
  await page.getByRole('button', { name: 'Place order' }).click();

  // The page's only real heading is the <h2> "Order"; "Order placed" is the
  // ion-title, which renders inside the toolbar's banner landmark and carries
  // no heading role, so asking for it by that role finds nothing. (It was
  // written that way to dodge a strict-mode collision — getByText('Order')
  // also matches the title and the "Place order" button — and traded an
  // ambiguous locator for one that could never match.)
  //
  // The substantive assertion is the one below it: the platform answered with
  // an order id and the page is showing it. That is the whole output of
  // POST /api/v1/orders, which replies 200 with a bare GUID and no Location
  // header, so a rendered id is the only evidence the order exists.
  await expect(page.getByRole('heading', { name: 'Order', exact: true })).toBeVisible();
  await expect(page.locator('code')).toHaveText(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  await expect(
    page.getByText('The platform exposes no endpoint that reads an order back'),
  ).toBeVisible();

  // The page sends customer_request and offers no choice of reason: the
  // other four codes in CANCEL_REASONS are facts the platform discovers,
  // and this route stamps CommandOrigin.User regardless of the code sent.
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('The platform answered 204.')).toBeVisible();
});

test('a published product reaches the catalogue without a reload', async ({ page }) => {
  // Goes through the gateway's `catalog-write` route, which matches POST and
  // requires authentication — `catalog-public` matches GET alone. If this
  // test ever 404s at the edge, that route is the first thing to check.
  await signIn(page, 'demo', 'demo');

  const name = `Smoke ${Date.now()}`;

  await page.getByRole('tab', { name: 'Publish' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Amount').fill('9.99');
  await page.getByLabel('Currency').fill('EUR');
  await page.getByRole('button', { name: 'Publish' }).click();

  // The page stays put and shows the id the platform returned. It does not
  // navigate: spec §5.5 asks that the products tab refresh, which is not the
  // same as redirecting the person who published.
  await expect(page.getByText('Published as')).toBeVisible();

  // The assertion this whole test exists for. Ionic caches a tab's page and
  // reuses its ComponentRef, so ProductsPage's constructor runs once per app
  // session and a tab click alone loads nothing. The product is visible here
  // only because the publish asked CatalogRefresh for a reload. A
  // page.reload() anywhere in this test would reconstruct everything and hide
  // a failure of exactly that mechanism — so there is none.
  //
  // Every run leaves another `Smoke …` product in a shared catalogue that has
  // no delete endpoint, which looks like it must eventually push this one off
  // the page the test looks at. It cannot: GetProductsHandler.cs orders
  // `p.PublishedAt DESC, p.Id DESC`, so the product this run just published is
  // the first row of the first page no matter how many came before it. The
  // accumulation is untidy, not fragile.
  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.getByText(name)).toBeVisible();
});

test('browser holds no permissions: the publish tab is absent and the route refuses', async ({ page }) => {
  await signIn(page, 'browser', 'browser');

  // Not getByText('browser'): the catalogue accumulates published products
  // across runs and manual verification sessions, and one on this stack is
  // literally named "Browser test widget" — an unscoped substring match
  // against that name is a strict-mode violation waiting to happen. The
  // account page renders the signed-in username as its own heading
  // (account.page.ts's `<h2>{{ name }}</h2>`), so an exact heading match
  // names the element this line actually means to check.
  await expect(page.getByRole('heading', { name: 'browser', exact: true })).toBeVisible();
  await expect(page.getByText('None. Every write in this application will answer 403.')).toBeVisible();

  // The tab hides…
  await expect(page.getByRole('tab', { name: 'Publish' })).toHaveCount(0);

  // …and a direct navigation is refused, which is the other half. A hidden
  // button and a refused route are two different facts.
  //
  // Note what this does and does not prove. page.goto() is a full browser
  // navigation, and on the web this realm issues no refresh token
  // (spec §5.6), so the load ends the session: the guard below refuses an
  // ANONYMOUS caller, not the signed-in `browser` user. That is still the
  // guard doing its job — permissionGuard asks hasPermission(), which is
  // false for both — but a reader should not take this line as evidence
  // about `browser` specifically. The tab assertion above is that evidence.
  await page.goto('/tabs/publish');
  // Not %3A: a colon is a legal, unreserved character in a URL query string,
  // and neither the browser nor Router.createUrlTree encodes it here — the
  // live URL carries a literal ':'. permission.guard.ts's own queryParams
  // call is what produces it; percent-encoding it in this regex would just
  // be wrong about what ends up in the address bar.
  await expect(page).toHaveURL(/denied=catalog:write/);
  await expect(page.getByText('That page needs')).toBeVisible();
});
