import { expect, type Page } from '@playwright/test';

export const GATEWAY = 'http://localhost:5000';
export const KEYCLOAK = 'http://localhost:8080';

/**
 * Requires Docker and the backend checkout. Without the stack this fails on
 * connection rather than skipping — the backend's own rule is that a skip
 * fails open, and a smoke that quietly passes with nothing running is worse
 * than no smoke. Every spec calls it from a `beforeAll`.
 */
export async function requireGateway(request: import('@playwright/test').APIRequestContext) {
  const health = await request.get(`${GATEWAY}/health/ready`);
  expect(
    health.ok(),
    `The gateway is not answering at ${GATEWAY}. Start the backend's Compose stack first.`,
  ).toBe(true);
}

export async function signIn(page: Page, username: string, password: string) {
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
export async function publishProduct(page: Page, amount: string) {
  const name = `Smoke ${amount} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await page.getByRole('tab', { name: 'Publish' }).click();

  // By role with `disabled: false`, never by label: on the phone project
  // Ionic's scroll assist puts a disabled `cloned-input` copy of the focused
  // field into the DOM, and `getByLabel('Name')` then matches both (#250).
  const field = (role: 'textbox' | 'spinbutton', label: string) =>
    page.getByRole(role, { name: label, disabled: false });
  const submit = page.getByRole('button', { name: 'Publish' });

  // Filled, read back and retried until the form holds all three and Publish
  // is enabled. In WebKit a fill made while the tab was still being drawn did
  // not survive the page's construction, and Publish then stayed disabled for
  // the whole timeout (#250). A retry of the same three fills is what a person
  // would do, and the ceiling is stated rather than slept.
  await expect(async () => {
    await field('textbox', 'Name').fill(name);
    await field('spinbutton', 'Amount').fill(amount);
    await field('textbox', 'Currency').fill('EUR');
    await expect(field('textbox', 'Name')).toHaveValue(name, { timeout: 1_000 });
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await submit.click();
  await expect(page.getByText('Published as')).toBeVisible();

  return name;
}

/** The id the Publish page reports for the product it published last. */
export async function publishedId(page: Page): Promise<string> {
  return (
    await page.locator('app-publish').getByText('Published as').locator('code').innerText()
  ).trim();
}

/**
 * The `demo` user's token, by the realm's direct grant on `web-app` (the same
 * client the smoke signs in through).
 */
export async function demoToken(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const response = await request.post(`${KEYCLOAK}/realms/commerce/protocol/openid-connect/token`, {
    form: { grant_type: 'password', client_id: 'web-app', username: 'demo', password: 'demo' },
  });
  expect(response.ok(), 'Keycloak refused the demo user a token').toBe(true);
  return ((await response.json()) as { access_token: string }).access_token;
}
