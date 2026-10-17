import { afterEach, describe, expect, it } from 'vitest';
import { focusPageHeading } from './focus-page-heading';

/** A page as Ionic leaves it: a host holding a header with a title, and content. */
function mountPage(markup: string): HTMLElement {
  const page = document.createElement('div');
  page.className = 'ion-page';
  page.innerHTML = markup;
  document.body.append(page);
  return page;
}

describe('focusPageHeading', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses the title of the page that was entered', () => {
    const page = mountPage('<ion-header><ion-title>Cart</ion-title></ion-header>');
    const entered = new Event('ionViewDidEnter', { bubbles: true });
    page.dispatchEvent(entered);

    focusPageHeading(Object.defineProperty(entered, 'target', { value: page }));

    const title = page.querySelector('ion-title');
    expect(document.activeElement).toBe(title);
    expect(title?.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves focus alone on a page with no title', () => {
    const page = mountPage('<main>Nothing here</main>');
    const before = document.activeElement;

    focusPageHeading(Object.defineProperty(new Event('ionViewDidEnter'), 'target', { value: page }));

    expect(document.activeElement).toBe(before);
  });

  it('does not take a title from inside the page content, such as a sheet', () => {
    const page = mountPage(
      '<ion-content><ion-modal><ion-header><ion-title>Sheet</ion-title></ion-header></ion-modal></ion-content>',
    );

    focusPageHeading(Object.defineProperty(new Event('ionViewDidEnter'), 'target', { value: page }));

    expect(document.activeElement).not.toBe(page.querySelector('ion-title'));
  });
});
