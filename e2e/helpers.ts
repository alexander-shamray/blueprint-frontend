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
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Currency').fill('EUR');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published as')).toBeVisible();

  return name;
}
