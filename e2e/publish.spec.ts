import { expect, test } from '@playwright/test';
import { requireGateway, signIn } from './helpers';

/**
 * #107 and #108 against the real stack: an image goes to the object store
 * through the BFF's pre-signed URL, the product is published with its key,
 * the seller's own list shows it, and a withdrawal takes it off the
 * catalogue. The unit suite mocks the store; this is the one place the
 * browser's own CORS check on the `PUT` is made (`client-architecture.md`
 * §11), in each of the three projects.
 */

/**
 * A 1×1 PNG. Catalog reads the first bytes of the stored object and refuses
 * one whose signature is not the type its key carries, so a few bytes of
 * anything would be `product.image_not_an_image`.
 */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwABAQEABRjYTgAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeAll(async ({ request }) => requireGateway(request));

test('an image uploads, publishes with the product, and a withdrawal takes the product off the catalogue', async ({
  page,
}) => {
  await signIn(page, 'demo', 'demo');
  const name = `Image ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await page.getByRole('tab', { name: 'Publish' }).click();

  // The chooser is an input `WebImageSource` attaches for the length of the
  // choice, so the file is handed to the chooser event rather than to a
  // locator.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('choose-image').click();
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL });

  // Both hops have landed: the BFF's issue and the store's PUT.
  await expect(page.getByTestId('image-status')).toHaveText('pixel.png: ready');

  // Filled after the upload, not straight after the tab click. WebKit took the
  // first fill while it was still drawing the Account tab, and the Name it
  // typed did not survive the Publish page's construction: Publish stayed
  // disabled on an empty Name for the whole timeout. By now the page has done
  // a round trip, and the value is read back before anything relies on it.
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Amount').fill('3.00');
  await page.getByLabel('Currency').fill('EUR');
  await expect(page.getByLabel('Name')).toHaveValue(name);

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published as')).toBeVisible();

  // The own list hears the same refresh the Products tab does, and the row it
  // reads back carries the image Catalog copied to products/.
  const row = page.locator('app-own-products').getByTestId('own-product').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator('img')).toHaveAttribute('src', /\/products\//);

  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.locator('app-products').getByText(name)).toBeVisible();

  await page.getByRole('tab', { name: 'Publish' }).click();
  await row.getByTestId('withdraw').click();
  await row.getByTestId('confirm-withdraw').click();
  await expect(row.getByTestId('withdrawn')).toBeVisible();

  // The withdrawal asked for the catalogue's reload, and the listing hides a
  // withdrawn product (backend ADR-074).
  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.locator('app-products').getByText(name)).toHaveCount(0);
});
