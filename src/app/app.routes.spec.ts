import { describe, expect, it } from 'vitest';
import { A11Y_ROUTES } from '../../e2e/a11y-routes';
import { routes } from './app.routes';

/**
 * The accessibility gate walks `A11Y_ROUTES` (e2e/a11y.spec.ts). This is the
 * half that keeps that list honest: a route added to the router and not to the
 * walk would otherwise be the one page no scan has ever seen, and the gate
 * would stay green over it.
 *
 * It reads the router's own table rather than a copy of it, and takes every
 * `tabs` child that renders a page — a pure redirect has nothing to scan.
 */
function renderedTabPaths(): string[] {
  const tabs = routes.find((route) => route.path === 'tabs');
  return (tabs?.children ?? [])
    .filter((route) => route.redirectTo === undefined)
    .map((route) => route.path ?? '');
}

describe('the accessibility walk', () => {
  it('names exactly the routes the router renders under tabs', () => {
    expect([...A11Y_ROUTES].sort()).toEqual(renderedTabPaths().sort());
  });

  it('is reading a router that has pages to scan', () => {
    // The subject check: an empty or renamed `tabs` route would make the
    // equality above compare two empty lists and pass.
    expect(renderedTabPaths().length).toBeGreaterThan(0);
  });
});
