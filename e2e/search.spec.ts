import { expect, test } from '@playwright/test';
import { publishProduct, requireGateway, signIn } from './helpers';

/**
 * #106 against the real listing: the search and the sort are the server's,
 * so the only place their meaning is checked is here. The unit suite proves
 * what is sent; this proves that what is sent finds the product.
 */

test.beforeAll(async ({ request }) => requireGateway(request));

test('a search finds a product by its name, and a search for nothing says so', async ({ page }) => {
  await signIn(page, 'demo', 'demo');
  const name = await publishProduct(page, '2.00');

  await page.getByRole('tab', { name: 'Products' }).click();
  const products = page.locator('app-products');
  // The label names the searchbar's search landmark; Ionic names the input
  // inside it itself, so the input is found through the landmark.
  const search = products.getByRole('search', { name: 'Search products' }).getByRole('searchbox');

  // Each step waits for the listing's reply under the query it names, since
  // the box is debounced and an unsearched listing already shows the newest
  // product: a check made before that reply would prove nothing.
  const listed = (q: string | null, sort?: string) =>
    page.waitForResponse((r) => {
      const url = new URL(r.url());
      if (!url.pathname.endsWith('/api/v1/catalog/products')) return false;
      return (
        url.searchParams.get('q') === q &&
        (sort === undefined || url.searchParams.get('sort') === sort)
      );
    });

  // The whole name, which no other product shares: the helper makes it unique.
  const found = listed(name);
  await search.fill(name);
  expect((await found).ok()).toBe(true);
  await expect(products.locator('ion-item').filter({ hasText: name })).toHaveCount(1);
  await expect(products.getByTestId('end-of-list')).toHaveText('That is every match.');

  const missing = `${name} no such product`;
  const none = listed(missing);
  await search.fill(missing);
  expect((await none).ok()).toBe(true);
  await expect(products.getByText(`No results for “${missing}”`)).toBeVisible();

  // Cleared, then sorted by name: the reply that counts carries no `q`.
  const cleared = listed(null);
  await search.fill('');
  expect((await cleared).ok()).toBe(true);
  const sorted = listed(null, 'name');
  // The segment button itself: its role is `tab`, but the inner button that
  // role resolves to sits under the host, which takes the pointer.
  await products.locator('ion-segment-button[value="name"]').click();
  expect((await sorted).ok()).toBe(true);
  await expect(products.getByRole('tab', { name: 'Name' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Never empty: this test has just published a product.
  await expect(products.locator('ion-item').first()).toBeVisible();
});
