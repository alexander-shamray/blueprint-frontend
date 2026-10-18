import { expect, test } from '@playwright/test';
import { GATEWAY, demoToken, publishProduct, publishedId, requireGateway, signIn } from './helpers';

/**
 * #97: an order walked to `Delivered`, the client twin of the backend's
 * `FulfilmentJourney` (blueprint-backend#426). The smoke's order ends at
 * `Out of stock` because its products are never stocked; this one is, so the
 * fulfilment saga reserves, Payments authorises, and Shipping books the parcel
 * with the carrier simulator, whose default feed reports it collected and
 * then delivered.
 *
 * Nothing here is a door in the client. The stock is set through Inventory's
 * own admin route (`PUT /api/v1/inventory/stock/{id}`, `inventory:admin`,
 * which the realm grants `demo` locally), and despatch and delivery are the
 * stack's own timers: Shipping's fulfilment tick books the parcel, and its
 * tracking poll reads the carrier's events (the backend's `CarrierHop`).
 *
 * Waits are on what the buyer sees, with a stated ceiling and no sleep. The
 * order-placed page follows the order's status stream and stops only on a
 * final status, so `Delivered` arriving there is the claim; the detail's
 * timeline then draws every forward step, and offers no Cancel.
 */

/** Stocked well above the one unit ordered, so the reservation never meets a shortfall. */
const STOCKED = 5;

/**
 * How long the buyer waits for `Delivered`. The backend's own journey budget
 * for that leg (`Deadlines.Confirmed + Dispatched + Delivered`) counts the
 * tracking poll's 30-second interval once, beside a few ticks and message
 * hops; three minutes covers it with a slow runner's margin.
 */
const DELIVERED_WITHIN_MS = 180_000;

test.beforeAll(async ({ request }) => requireGateway(request));

test('demo orders a stocked product and follows it to Delivered', async ({ page, request }) => {
  test.setTimeout(DELIVERED_WITHIN_MS + 90_000);
  await signIn(page, 'demo', 'demo');

  const name = await publishProduct(page, '6.00');
  const productId = await publishedId(page);

  // A first write creates the stock row, so this need not wait for Inventory
  // to hear of the product (SetOnHandHandler ensures, then sets).
  const stocked = await request.put(`${GATEWAY}/api/v1/inventory/stock/${productId}`, {
    headers: { authorization: `Bearer ${await demoToken(request)}` },
    data: { onHand: STOCKED },
  });
  expect(stocked.ok(), `Inventory refused the stock for ${productId}: ${stocked.status()}`).toBe(
    true,
  );

  // Newest first, so the product just published is on the first page.
  await page.getByRole('tab', { name: 'Products' }).click();
  const row = page.locator('app-products ion-item').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add' }).click();

  await page.getByRole('tab', { name: 'Cart' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByText(/Total:/)).toBeVisible();

  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Line 1').fill('1 Example Street');
  await page.getByLabel('City').fill('Doha');
  await page.getByLabel('Postal code').fill('00000');
  await page.getByLabel('Country').selectOption('QA');
  await page.getByRole('button', { name: 'Place order' }).click();

  const placed = page.locator('app-order-placed');
  await expect(placed.locator('code')).toHaveText(/^[0-9a-f-]{36}$/i);

  // The chip, then the note that says the stream has stopped. A cancellation
  // is not final (#158), so `Delivered` is the one status that ends the wait
  // for the page itself.
  await expect(placed.getByText('Delivered')).toBeVisible({ timeout: DELIVERED_WITHIN_MS });
  await expect(placed.getByTestId('status-note')).toHaveText(
    'This order has reached its last status.',
  );

  await page.getByRole('link', { name: 'Track this order' }).click();
  const timeline = page.locator('app-order-detail').getByTestId('timeline');
  // A moving order draws every forward step and marks the unreached ones
  // `pending` ("Not reached yet"), so the labels alone would pass with none
  // reached. Every step is drawn and none is pending: the read carries a
  // time for each.
  for (const step of ['Placed', 'Confirmed', 'Dispatched', 'Delivered']) {
    await expect(timeline).toContainText(step);
  }
  await expect(timeline.locator('ion-item.pending')).toHaveCount(0);
  await expect(timeline).not.toContainText('Not reached yet');
  await expect(timeline).not.toContainText('Out of stock');
  await expect(
    page.locator('app-order-detail').getByRole('button', { name: 'Cancel order' }),
  ).toHaveCount(0);
});
