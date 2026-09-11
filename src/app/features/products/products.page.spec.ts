import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CartStore } from '@core/cart/cart.store';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { ProductsPage } from './products.page';

const page = (n: number, nextCursor: string | null) => ({
  items: Array.from({ length: n }, (_, i) => ({
    productId: `p${i}`,
    name: `Product ${i}`,
    thumbnailUrl: null,
    amount: 10 + i,
    currency: 'EUR',
    publishedAt: '2026-09-10T00:00:00Z',
  })),
  nextCursor,
});

describe('ProductsPage', () => {
  let fixture: ComponentFixture<ProductsPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [ProductsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });

    fixture = TestBed.createComponent(ProductsPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => controller.verify());

  it('loads the first page with limit=20 and no cursor', () => {
    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush(page(20, 'cursor-2'));
  });

  it('appends the next page using the reply nextCursor', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    fixture.componentInstance.loadMore();

    const second = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(second.request.params.get('cursor')).toBe('cursor-2');

    second.flush(page(5, null));
    await fixture.whenStable();

    expect(fixture.componentInstance.products()).toHaveLength(25);
    // A null nextCursor is the last page, so nothing asks for another.
    expect(fixture.componentInstance.hasMore()).toBe(false);
  });

  it('adds a product to the cart without calling the platform', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(1, null));
    await fixture.whenStable();

    fixture.componentInstance.addToCart(fixture.componentInstance.products()[0]);

    expect(TestBed.inject(CartStore).count()).toBe(1);
    controller.verify();
  });

  it('shows the mapped banner when the listing fails', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(
        { title: 'Too many requests', status: 429 },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.kind).toBe('rateLimited');
  });

  it('drops a stale loadMore() response that lands after reload() started a new sequence', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    // A loadMore() is in flight, requesting page 2 with cursor-2...
    fixture.componentInstance.loadMore();
    const stale = controller.expectOne(
      (r) =>
        r.url === 'http://localhost:5000/api/v1/catalog/products' &&
        r.params.get('cursor') === 'cursor-2',
    );

    // ...when the publish page (Task 14) calls reload() mid-flight.
    fixture.componentInstance.reload();
    const fresh = controller.expectOne(
      (r) =>
        r.url === 'http://localhost:5000/api/v1/catalog/products' && !r.params.has('cursor'),
    );

    // The fresh first page lands first...
    fresh.flush(page(3, 'cursor-fresh'));
    await fixture.whenStable();

    // ...then the stale page-2 response lands late, from a sequence reload()
    // already discarded. It must not be applied.
    stale.flush(page(5, 'cursor-stale-next'));
    await fixture.whenStable();

    expect(fixture.componentInstance.products()).toHaveLength(3);
    expect(fixture.componentInstance.hasMore()).toBe(true);

    // The next page must continue the reloaded sequence's cursor, not the
    // one the dropped stale response tried to install.
    fixture.componentInstance.loadMore();
    const next = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(next.request.params.get('cursor')).toBe('cursor-fresh');
    next.flush(page(0, null));
  });

  it('construction alone does not double-fetch (CatalogRefresh untouched)', async () => {
    // The first HTTP request in beforeEach is the one and only load() this
    // component makes on its own. Confirming there is no second one pending
    // is what distinguishes "the effect skipped its own first run" from "the
    // effect happens to never have fired yet".
    controller.expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products').flush(page(1, null));
    await fixture.whenStable();

    controller.verify();
  });

  it('CatalogRefresh.request() triggers exactly one reload, starting from the first page', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    TestBed.inject(CatalogRefresh).request();
    await fixture.whenStable();

    // Exactly one reload: a single new request, carrying no cursor — a
    // refresh restarts pagination from the first page rather than resuming
    // from wherever the stale list had scrolled to.
    const refreshed = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(refreshed.request.params.has('cursor')).toBe(false);
    refreshed.flush(page(3, null));
    await fixture.whenStable();

    expect(fixture.componentInstance.products()).toHaveLength(3);
  });

  it('a reload triggered by CatalogRefresh drops a stale loadMore() the same way a manual reload() does', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    // A loadMore() is in flight...
    fixture.componentInstance.loadMore();
    const stale = controller.expectOne(
      (r) =>
        r.url === 'http://localhost:5000/api/v1/catalog/products' &&
        r.params.get('cursor') === 'cursor-2',
    );

    // ...when a publish elsewhere bumps CatalogRefresh mid-flight, exactly as
    // a direct reload() call would.
    TestBed.inject(CatalogRefresh).request();
    await fixture.whenStable();
    const fresh = controller.expectOne(
      (r) =>
        r.url === 'http://localhost:5000/api/v1/catalog/products' && !r.params.has('cursor'),
    );

    fresh.flush(page(2, null));
    await fixture.whenStable();

    // The stale page-2 response lands late and must be dropped, same as the
    // manual-reload() case above — the version-generation guard in load()
    // does not distinguish who called reload().
    stale.flush(page(5, 'cursor-stale-next'));
    await fixture.whenStable();

    expect(fixture.componentInstance.products()).toHaveLength(2);
    expect(fixture.componentInstance.hasMore()).toBe(false);
  });
});
