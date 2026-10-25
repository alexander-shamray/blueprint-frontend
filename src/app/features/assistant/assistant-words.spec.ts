import { describe, expect, it } from 'vitest';
import { TURN_END_REASONS } from '@core/assistant/protocol';
import { endLabel, problemLabel, toolLabel } from './assistant-words';
import { OPENABLE_PAGES, shopTools } from './shop-tools';

describe("the panel's words for the protocol's codes (design §5.4)", () => {
  it('words every end but an ordinary one, and a refusal plainly', () => {
    expect(endLabel('done')).toBeNull();
    for (const reason of TURN_END_REASONS.filter((r) => r !== 'done')) {
      expect(endLabel(reason)?.trim()).toBeTruthy();
    }
    expect(endLabel('refused')).toMatch(/declined/);
  });

  it('words every problem code', () => {
    for (const code of ['turn-running', 'failed', 'provider', 'gone'] as const) {
      expect(problemLabel({ code, detail: null }).trim()).toBeTruthy();
    }
  });

  it("words each of the BFF's reads and each of this client's tools in its own words", () => {
    const general = toolLabel('something_new', {});
    const names = [
      'list_orders',
      'get_order',
      'get_product',
      ...shopTools({ navigate: async () => true, canPublish: () => true })
        .map((t) => t.descriptor.name)
        .filter((name) => name !== 'open_page'),
    ];

    const labels = names.map((name) => toolLabel(name, {}));

    expect(labels).not.toContain(general);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('words each page open_page opens, and a page it does not know generally', () => {
    const labels = OPENABLE_PAGES.map((page) => toolLabel('open_page', { page }));
    const unknown = toolLabel('open_page', { page: 'elsewhere' });

    expect(labels).not.toContain(unknown);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
