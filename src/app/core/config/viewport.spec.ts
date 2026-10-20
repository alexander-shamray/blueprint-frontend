import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #86, `docs/client-architecture.md` §15: the page draws under the notch, so
 * `env(safe-area-inset-*)` carries the real insets and Ionic's
 * `--ion-safe-area-*` variables pad the header and the tab bar by them.
 *
 * The subject is the one attribute that turns that on. Without
 * `viewport-fit=cover` the browser keeps the page inside the safe area and
 * every inset reads zero, so Ionic's handling is present and does nothing; no
 * other gate would notice, because the page still renders. What it does on a
 * device is not asserted here and has not been measured.
 */
const html = readFileSync(join(process.cwd(), 'src', 'index.html'), 'utf8');

/** The `content` of the live viewport meta tag, whatever order its attributes are in. */
function viewport(source: string): string | undefined {
  const live = source.replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<meta\b[^>]*\bname="viewport"[^>]*>/.exec(live)?.[0];
  return tag && /\bcontent="([^"]*)"/.exec(tag)?.[1];
}

describe('the viewport lets the page draw under the notch (#86)', () => {
  it('is read from a viewport tag that exists, with a width', () => {
    expect(viewport(html)).toMatch(/\bwidth=device-width\b/);
  });

  it('asks for viewport-fit=cover', () => {
    expect(viewport(html)).toMatch(/(^|,)\s*viewport-fit=cover\s*(,|$)/);
  });

  it('reads the tag and not a mention of it elsewhere', () => {
    const mention = '<!-- <meta name="viewport" content="viewport-fit=cover"> -->';
    expect(viewport(mention + '<meta name="viewport" content="width=device-width">')).not.toMatch(
      /viewport-fit/,
    );
  });
});
