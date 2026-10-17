import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { A11Y_ROUTES, type A11yRoute } from './a11y-routes';
import { publishProduct, requireGateway, signIn } from './helpers';

test.beforeAll(async ({ request }) => {
  await requireGateway(request);
});

/**
 * Animations that finish, awaited; the ones that repeat (a spinner) are left
 * running. Axe computes contrast from the painted colours, and Ionic fades a
 * page in over about half a second, so a scan taken mid-transition measures a
 * colour the user never sees at rest.
 */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/**
 * The address a route is reached at, with the one parameter any route takes.
 * The sign-in callback leaves `?iss=…` on the address (the app never strips
 * it), so that query is allowed; a guard's bounce carries `denied=` or
 * `signIn=`, which is not, and is the whole point of asserting the address.
 */
function addressOf(route: A11yRoute): RegExp {
  return new RegExp(`/tabs/${route.replace(':id', '[^/]+')}(\\?iss=[^#]*)?$`);
}

/**
 * Both palettes, because the dark one is `dark.system.css` — a stylesheet
 * applied by the OS preference — and a scan in the default scheme says nothing
 * about it (`src/theme/variables.css`). The whole journey runs once per scheme,
 * each placing its own order against the real stack.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} palette`, () => {
    test.use({ colorScheme });

    test('every route, in the state a user sees it, has no serious or critical violation', async ({
      page,
    }) => {
      const scanned = new Set<A11yRoute>();

      /**
       * Scans the page the browser is on and names it as `route`. It asserts
       * the address first, so a guard that bounced the walk to another page
       * fails here instead of scanning that page and calling it this one.
       */
      async function scan(route: A11yRoute, state: string) {
        await expect(page).toHaveURL(addressOf(route));
        await settle(page);
        const { violations } = await new AxeBuilder({ page }).analyze();
        const blocking = violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => ({
            rule: violation.id,
            impact: violation.impact,
            help: violation.help,
            targets: violation.nodes.map((node) => node.target.join(' ')),
            why: violation.nodes.map((node) => node.failureSummary),
          }));
        expect(blocking, `${route} (${state}), ${colorScheme}`).toEqual([]);
        scanned.add(route);
      }

      // Signed out. The cart is empty and Account offers sign-in.
      await page.goto('/tabs/products');
      await expect(page.getByRole('tab', { name: 'Products' })).toBeVisible();
      await scan('products', 'signed out');
      await page.getByRole('tab', { name: 'Cart' }).click();
      await scan('cart', 'empty');
      await page.getByRole('tab', { name: 'Account' }).click();
      await scan('account', 'signed out');

      // Signed in as the user who holds `catalog:write`, which is what puts the
      // Publish route in front of the guard in the state a person sees it.
      await signIn(page, 'demo', 'demo');
      await expect(page.getByText('catalog:write')).toBeVisible();
      await scan('account', 'signed in');

      const name = await publishProduct(page, '12.50');
      await scan('publish', 'after publishing');

      await page.getByRole('tab', { name: 'Products' }).click();
      await page.getByRole('button', { name }).click();
      // By its name, so the scan waits for the sheet to be presented and
      // named, and a dialog that lost its name fails here with a clearer
      // message than axe's.
      await expect(page.getByRole('dialog', { name })).toBeVisible();
      await scan('products', 'with the product sheet open');
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.getByTestId('sheet-price')).toBeHidden();
      await scan('products', 'sheet closed');

      await page.getByRole('tab', { name: 'Cart' }).click();
      await page.getByRole('button', { name: 'Get quote' }).click();
      await expect(page.getByText(/Total:/)).toBeVisible();
      await scan('cart', 'quoted');

      await page.getByRole('button', { name: 'Checkout' }).click();
      await scan('cart/checkout', 'empty form');
      await page.getByLabel('Line 1').fill('1 Example Street');
      await page.getByLabel('City').fill('Doha');
      await page.getByLabel('Postal code').fill('00000');
      await page.getByLabel('Country').selectOption('QA');
      await page.getByRole('button', { name: 'Place order' }).click();

      await expect(page.locator('app-order-placed code')).toHaveText(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // The status chip is what the page settles on; scanning before it
      // arrives would scan the polling state, which a person sees for seconds.
      await expect(page.locator('app-order-placed').getByText('Out of stock')).toBeVisible({
        timeout: 30_000,
      });
      await scan('cart/placed/:id', 'order placed');

      await page.getByRole('link', { name: 'Track this order' }).click();
      await expect(page.locator('app-order-detail').getByTestId('timeline')).toBeVisible();
      await scan('orders/:id', 'a finished timeline');

      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.locator('app-orders')).toBeVisible();
      await scan('orders', 'with an order in it');

      // The other half of the gate: every route above was reached, and every
      // route the list names was reached. `app.routes.spec.ts` holds the list
      // to the router.
      expect([...scanned].sort()).toEqual([...A11Y_ROUTES].sort());
    });
  });
}
