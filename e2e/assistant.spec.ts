import { expect, test } from '@playwright/test';
import { requireGateway, signIn } from './helpers';

/**
 * #350: the assistant panel against the BFF it is written for. The backend's
 * Compose stack starts the BFF with `Assistant__Provider: "scripted"`
 * (`deploy/compose/services/web-bff.yml`, blueprint-backend ADR-156), which
 * needs no key and answers every turn with one fixed reply, streamed a word at
 * a time. So this proves the round trip — the status read, the conversation,
 * the turn and its event stream, all through the gateway with the bearer — and
 * nothing about a model.
 */
const SCRIPTED_REPLY =
  'This is the scripted assistant, so no model read your message. It answers every turn with this reply.';

test.beforeAll(async ({ request }) => {
  await requireGateway(request);
});

test('demo asks the assistant and reads its reply', async ({ page }) => {
  await signIn(page, 'demo', 'demo');

  await page.getByRole('button', { name: 'Ask the assistant' }).click();

  const notice = page.getByTestId('assistant-notice');
  await expect(notice).toContainText('scripted');
  await page.getByTestId('assistant-notice-ok').click();
  await expect(notice).toBeHidden();

  // By role with `disabled: false`, never by label: on the phone project
  // Ionic's scroll assist puts a disabled copy of the focused field into the
  // DOM (#250, as `publishProduct` says).
  await page.getByRole('textbox', { name: 'Message', disabled: false }).fill('Where is my order?');
  await page.getByTestId('assistant-send').click();

  await expect(page.getByTestId('assistant-mine')).toHaveText('Where is my order?');
  await expect(page.getByTestId('assistant-reply')).toHaveText(SCRIPTED_REPLY);
  await expect(page.getByTestId('assistant-problem')).toHaveCount(0);
});
