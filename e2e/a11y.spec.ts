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
 * Focus is on the title of the page the user has just reached. Axe cannot see
 * this: it reads the page at rest, not where the cursor went after a
 * navigation (#240). Retried, because Ionic focuses once the transition ends.
 */
async function expectTitleFocused(page: Page, title: string) {
  await expect(page.locator('ion-title:focus')).toHaveText(title);
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
        // Polled, not scanned once: Ionic fades a page in, and on WebKit under
        // Linux a scan taken as the page arrives measured text at 1.01:1
        // (#fdfdfd on #fff) — a colour no one sees at rest, and one that
        // `settle` cannot wait out because Ionic drives some of the fade
        // itself. A violation present at rest is present on every poll and
        // fails when the window ends; one that was only the fade clears.
        //
        // The ceiling is 15 s because one WebKit scan of the quoted cart, late
        // in a full run against a stack holding every earlier test's orders,
        // outlasted 5 s (#268). Playwright's own message for that, "Timeout
        // 5000ms exceeded while waiting on the predicate", means no poll
        // returned a value at all, so `last` records how far the poll got: a
        // red run says whether a scan finished and what it held, or never
        // finished. The ceiling holds only while the walk is inside the test's
        // 60 s budget (playwright.config.ts); past that Playwright reports the
        // test timeout instead, and `last` is not shown.
        let last = 'no scan finished';
        try {
          await expect
            .poll(
              async () => {
                await settle(page);
                const { violations } = await new AxeBuilder({ page }).analyze();
                const serious = violations
                  .filter(
                    (violation) =>
                      violation.impact === 'serious' || violation.impact === 'critical',
                  )
                  .map((violation) => ({
                    rule: violation.id,
                    impact: violation.impact,
                    help: violation.help,
                    targets: violation.nodes.map((node) => node.target.join(' ')),
                    why: violation.nodes.map((node) => node.failureSummary),
                  }));
                last = JSON.stringify(serious);
                return serious;
              },
              { message: `${route} (${state}), ${colorScheme}`, timeout: 15_000 },
            )
            .toEqual([]);
        } catch (error) {
          throw new Error(
            `${route} (${state}), ${colorScheme}: the last scan to finish held ${last}`,
            { cause: error },
          );
        }
        scanned.add(route);
      }

      // Signed out. The cart is empty and Account offers sign-in.
      await page.goto('/tabs/products');
      await expect(page.getByRole('tab', { name: 'Products' })).toBeVisible();
      await scan('products', 'signed out');
      await page.getByRole('tab', { name: 'Cart' }).click();
      await expectTitleFocused(page, 'Cart');
      await scan('cart', 'empty');
      await page.getByRole('tab', { name: 'Account' }).click();
      await expectTitleFocused(page, 'Account');
      await scan('account', 'signed out');

      // Signed in as the user who holds `catalog:write`, which is what puts the
      // Publish route in front of the guard in the state a person sees it.
      await signIn(page, 'demo', 'demo');
      await expect(page.getByText('catalog:write')).toBeVisible();
      await scan('account', 'signed in');

      const name = await publishProduct(page, '12.50');
      await scan('publish', 'after publishing');

      await page.getByRole('tab', { name: 'Products' }).click();
      await expectTitleFocused(page, 'Products');
      await scan('products', 'with a product published');
      await page.getByRole('link', { name }).click();
      await expect(page.getByTestId('product-name')).toHaveText(name);
      await expectTitleFocused(page, 'Product');
      await scan('products/:id', 'a published product');
      // Kept for the end of the walk, where a full load cannot cost the
      // session the cart and checkout below depend on.
      const productAddress = page.url();
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.getByTestId('product-added')).toHaveText('Added 1 to the cart.');

      await page.getByRole('tab', { name: 'Cart' }).click();
      await page.getByRole('button', { name: 'Get quote' }).click();
      await expect(page.getByText(/Total:/)).toBeVisible();
      await scan('cart', 'quoted');

      await page.getByRole('button', { name: 'Checkout' }).click();
      await expectTitleFocused(page, 'Checkout');
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
      await expectTitleFocused(page, 'Order placed');
      await scan('cart/placed/:id', 'order placed');

      await page.getByRole('link', { name: 'Track this order' }).click();
      await expect(page.locator('app-order-detail').getByTestId('timeline')).toBeVisible();
      await expectTitleFocused(page, 'Order');
      await scan('orders/:id', 'a finished timeline');

      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.locator('app-orders')).toBeVisible();
      await expectTitleFocused(page, 'History');
      await scan('orders', 'with an order in it');

      // The product's address opened cold, as a shared link is (#105), and
      // one that names nothing the platform has: a stated page, not a banner.
      await page.goto(productAddress);
      await expect(page.getByTestId('product-name')).toHaveText(name);
      await page.goto('/tabs/products/00000000-0000-7000-8000-000000000000');
      await expect(page.getByText('This product is not available')).toBeVisible();
      await scan('products/:id', 'not available');

      // The other half of the gate: every route above was reached, and every
      // route the list names was reached. `app.routes.spec.ts` holds the list
      // to the router.
      expect([...scanned].sort()).toEqual([...A11Y_ROUTES].sort());
    });
  });
}
