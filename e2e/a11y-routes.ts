/**
 * The tab routes the accessibility walk in `a11y.spec.ts` scans, spelled as
 * `src/app/app.routes.ts` spells them under `tabs`. Plain data with no imports,
 * so both the Playwright spec and the unit suite can read it:
 * `app.routes.spec.ts` fails when this list and the router disagree, and the
 * walk itself fails when it scans a route not named here or names one it never
 * reached. Without the first, the gate stops covering the next route added;
 * without the second, the list is a claim nobody walks.
 */
export const A11Y_ROUTES = [
  'products',
  'products/:id',
  'cart',
  'cart/checkout',
  'cart/placed/:id',
  'orders',
  'orders/:id',
  'publish',
  'account',
] as const;

export type A11yRoute = (typeof A11Y_ROUTES)[number];
