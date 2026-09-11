import { describe, expect, it } from 'vitest';
import { CatalogRefresh } from './catalog-refresh';

describe('CatalogRefresh', () => {
  it('starts at version 0', () => {
    expect(new CatalogRefresh().current()).toBe(0);
  });

  it('request() bumps the version', () => {
    const refresh = new CatalogRefresh();

    refresh.request();

    expect(refresh.current()).toBe(1);
  });

  it('each request() bumps again, so repeated publishes are each observable', () => {
    const refresh = new CatalogRefresh();

    refresh.request();
    refresh.request();

    expect(refresh.current()).toBe(2);
  });
});
