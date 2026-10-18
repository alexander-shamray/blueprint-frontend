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

  // The whole name, which no other product shares: the helper makes it unique.
  await search.fill(name);
  await expect(products.locator('ion-item').filter({ hasText: name })).toHaveCount(1);
  await expect(products.getByTestId('end-of-list')).toHaveText('That is every match.');

  await search.fill(`${name} no such product`);
  await expect(products.getByText(`No results for “${name} no such product”`)).toBeVisible();

  // Sorted by name with the search cleared, the listing is still the server's:
  // the restart asks for it, and the server answers a page.
  await search.fill('');
  const sorted = page.waitForResponse(
    (r) => r.url().includes('/api/v1/catalog/products?') && r.url().includes('sort=name'),
  );
  // The segment button itself: its role is `tab`, but the inner button that
  // role resolves to sits under the host, which takes the pointer.
  await products.locator('ion-segment-button[value="name"]').click();
  expect((await sorted).ok()).toBe(true);
  await expect(products.getByRole('tab', { name: 'Name' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(products.locator('ion-item').first()).toBeVisible();
});
