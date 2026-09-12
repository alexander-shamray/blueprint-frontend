import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { AuthService } from '@core/auth/auth.service';
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
        // The real interceptor pair, in app order. The 429 window is no longer
        // driven by this page's error signal — `rateLimitInterceptor` opens it
        // from the response — so a spec that left them out would be testing a
        // page whose rate-limit binding nothing can ever set.
        provideHttpClient(withInterceptors([authInterceptor, rateLimitInterceptor])),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
        // Signed OUT, which is the case this page is unusual for: with no
        // bearer the gateway partitions a catalogue read by IP, so the
        // refusals below land in the anonymous window and `rateLimit` —
        // bound to `catalogue` — follows that one.
        { provide: AuthService, useValue: { user: () => signal(null), accessToken: () => null } },
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

  it('offers a way back after a failed first load, and the retry starts from the first page', async () => {
    // The landing tab's very first listing fails. Before the Try again
    // control existed this was terminal for the session: the infinite scroll
    // stops asking on a failure, and nothing else on the page could issue
    // another request.
    //
    // A 503 rather than a 429 on purpose: a 429 opens a retry window during
    // which this button is deliberately dead (the test below), and this test
    // is about the affordance existing at all.
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(
        { title: 'Service unavailable', status: 503 },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    // The scroll stops asking on its own — retrying into a limiter
    // automatically is how a rate limit becomes a loop — but it stops because
    // an error stands, not because the catalogue said it had no more pages.
    expect(fixture.componentInstance.canLoadMore()).toBe(false);
    expect(fixture.componentInstance.hasMore()).toBe(true);

    const retry: HTMLElement = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Try again',
    );
    // Asserted through the DOM: a reload() the user cannot reach is not a
    // retry affordance, which is exactly what the page had before.
    expect(retry).toBeTruthy();

    retry.click();
    await fixture.whenStable();

    const second = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    // The first page again — not because a failed sequence cannot be resumed
    // (the test below resumes one), but because this failure was the FIRST
    // page: `cursor` is still null, so resuming and restarting are the same
    // request.
    expect(second.request.params.has('cursor')).toBe(false);

    second.flush(page(2, null));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.products()).toHaveLength(2);
    expect(fixture.componentInstance.error()).toBeNull();
    // The control goes with the banner it belongs to.
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-button')].some(
        (el: HTMLElement) => el.textContent?.trim() === 'Try again',
      ),
    ).toBe(false);
  });

  it('a failed later page is retryable, and resumes from the cursor that failed', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    // Page two fails transiently. This used to be terminal for the session:
    // the error branch set hasMore false — correct for "no more pages", wrong
    // for "this attempt failed" — so after the 429's window closed, or after a
    // 503 passed, page two could never be asked for again.
    fixture.componentInstance.loadMore();
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(
        { title: 'Service unavailable', status: 503 },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    // The platform never said the listing had ended, and the client does not
    // say it on its behalf.
    expect(fixture.componentInstance.hasMore()).toBe(true);
    // It does stop the scroll asking by itself while the failure stands.
    expect(fixture.componentInstance.canLoadMore()).toBe(false);

    const retry: HTMLElement = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Try again',
    );
    expect(retry).toBeTruthy();
    retry.click();
    await fixture.whenStable();

    // Resumed, not restarted: cursor-2 is the page that never arrived, and the
    // twenty items already on screen are not thrown away to ask for it.
    const resumed = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(resumed.request.params.get('cursor')).toBe('cursor-2');

    resumed.flush(page(5, 'cursor-3'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.products()).toHaveLength(25);
    expect(fixture.componentInstance.error()).toBeNull();
    // And the scroll is armed again, at the cursor the resumed page returned.
    expect(fixture.componentInstance.canLoadMore()).toBe(true);

    fixture.componentInstance.loadMore();
    const next = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(next.request.params.get('cursor')).toBe('cursor-3');
    next.flush(page(0, null));
    await fixture.whenStable();
  });

  it('disables Try again while a 429 window is open', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(
        { title: 'Too many requests', status: 429 },
        { status: 429, statusText: 'Too Many Requests' },
        // No Retry-After header, so the mapper's own 60-second fallback
        // applies — the window is open either way, which is all this asserts.
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);

    // Asserted through the rendered button, not just the signal: spec §6 asks
    // for the ACTION to be disabled for that long, and a countdown beside a
    // live button is a countdown that changes nothing.
    const retry = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Try again',
    );
    expect(retry.disabled).toBe(true);
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

    // ...when reload() starts a fresh sequence mid-flight. Called directly
    // here; the CatalogRefresh path a publish actually takes is the test
    // below, and this one is about load()'s guard rather than the trigger.
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
