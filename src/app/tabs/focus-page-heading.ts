/**
 * Moves keyboard and screen-reader focus to the page's heading once Ionic has
 * finished entering it. A route change replaces the content under the user's
 * hands; without this, focus stays on the tab button or link that was
 * activated, or falls to the body, and a screen reader says nothing about the
 * page that arrived.
 *
 * Ionic dispatches `ionViewDidEnter` on the page element, bubbling, after the
 * transition has made it visible — the only point a `focus()` can land, since
 * an entering page is hidden until then. The title is an `ion-title`, which is
 * not focusable, so it takes `tabindex="-1"`: focusable by script, absent from
 * the tab order.
 */
export function focusPageHeading(event: Event): void {
  const page = event.target;
  if (!(page instanceof HTMLElement)) return;

  const heading = page.querySelector<HTMLElement>(':scope > ion-header ion-title');
  if (!heading) return;

  heading.setAttribute('tabindex', '-1');
  heading.focus();
}
