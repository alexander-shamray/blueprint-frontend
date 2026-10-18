import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartStore } from '@core/cart/cart.store';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CatalogAvailability } from '@core/catalog/catalog-availability';
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
    quantityAvailable: null,
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
        // The real interceptor. The 429 window is no longer driven by this
        // page's error signal — `rateLimitInterceptor` opens it from the
        // response — so a spec without it would be testing a page whose
        // rate-limit binding nothing can ever set. `authInterceptor` is not
        // here because nothing in that window depends on it any more: the
        // bucket is picked from the route, not from the bearer.
        provideHttpClient(withInterceptors([rateLimitInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
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

  it('keeps the infinite scroll quiet while the catalogue window is open, error or not', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();
    expect(fixture.componentInstance.canLoadMore()).toBe(true);

    // The refusal arrives on a catalogue read this page did not make, so its
    // own `error()` stays null. How the window came to be open is not the
    // page's business — that is the point of a window shared across the
    // bucket — and the scroll must not re-arm into a limiter the client
    // already knows is closed. `errorSignal` alone cannot express this state:
    // it says "MY last attempt failed", and the bucket is not this page's.
    TestBed.inject(HttpClient)
      .get('http://localhost:5000/api/v1/catalog/products')
      .subscribe({ error: () => undefined });
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(null, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '30' },
      });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.hasMore()).toBe(true);
    expect(fixture.componentInstance.canLoadMore()).toBe(false);
  });

  it('keeps the infinite scroll quiet while the first page is in flight', async () => {
    // beforeEach's first page is still out: no error, no window, and the
    // platform has not yet said there is no further page. A scroll now would
    // ask for page one a second time, and both replies would be appended.
    expect(fixture.componentInstance.hasMore()).toBe(true);
    expect(fixture.componentInstance.canLoadMore()).toBe(false);

    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    expect(fixture.componentInstance.canLoadMore()).toBe(true);

    // A later page is a different case: the scroll that asked for it holds
    // itself until complete(), and disabling it now would clear Ionic's
    // isLoading, hide the spinner and make that complete() do nothing.
    fixture.componentInstance.loadMore();
    const later = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(fixture.componentInstance.loading()).toBe(true);
    expect(fixture.componentInstance.canLoadMore()).toBe(true);

    later.flush(page(0, null));
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

  describe('a refresh asked for inside a blocked catalogue window (#161)', () => {
    const URL = 'http://localhost:5000/api/v1/catalog/products';

    const openWindow = async (): Promise<void> => {
      controller.expectOne((r) => r.url === URL).flush(page(20, 'cursor-2'));
      await fixture.whenStable();
      // A refusal on a read this page did not make, as the test above opens it.
      TestBed.inject(HttpClient).get(URL).subscribe({ error: () => undefined });
      controller.expectOne((r) => r.url === URL).flush(null, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '30' },
      });
      await fixture.whenStable();
      expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);
    };

    it('keeps the list and sends nothing while the window is open', async () => {
      await openWindow();

      TestBed.inject(CatalogRefresh).request();
      await fixture.whenStable();

      controller.expectNone((r) => r.url === URL);
      expect(fixture.componentInstance.products()).toHaveLength(20);
    });

    it('takes the held refresh from the first page once the window closes', async () => {
      await openWindow();
      TestBed.inject(CatalogRefresh).request();
      await fixture.whenStable();

      TestBed.inject(RateLimitWindows).forPartition('catalogue').close();
      await fixture.whenStable();

      const refreshed = controller.expectOne((r) => r.url === URL);
      expect(refreshed.request.params.has('cursor')).toBe(false);
      refreshed.flush(page(3, null));
      await fixture.whenStable();
      expect(fixture.componentInstance.products()).toHaveLength(3);
    });

    it('does not reload a second time when a pull to refresh took the hold first', async () => {
      await openWindow();
      TestBed.inject(CatalogRefresh).request();
      await fixture.whenStable();

      fixture.componentInstance.refresh();
      controller.expectOne((r) => r.url === URL).flush(page(3, null));
      await fixture.whenStable();

      TestBed.inject(RateLimitWindows).forPartition('catalogue').close();
      await fixture.whenStable();
      controller.expectNone((r) => r.url === URL);
    });
  });

  describe('a reload keeps the rows until the first page lands (#202)', () => {
    const URL = 'http://localhost:5000/api/v1/catalog/products';

    const loaded = async (): Promise<void> => {
      controller.expectOne((r) => r.url === URL).flush(page(20, 'cursor-2'));
      await fixture.whenStable();
    };

    it('leaves the rows and no skeleton on screen while the first page is in flight', async () => {
      await loaded();

      fixture.componentInstance.reload();
      await fixture.whenStable();

      expect(fixture.componentInstance.products()).toHaveLength(20);
      expect(fixture.componentInstance.showSkeleton()).toBe(false);
      controller.expectOne((r) => r.url === URL).flush(page(3, null));
    });

    it('replaces the rows with the reply, not extends them', async () => {
      await loaded();

      fixture.componentInstance.reload();
      controller.expectOne((r) => r.url === URL).flush(page(3, null));
      await fixture.whenStable();

      expect(fixture.componentInstance.products()).toHaveLength(3);
      expect(fixture.componentInstance.hasMore()).toBe(false);
    });

    it('keeps the infinite scroll quiet while the restart is in flight', async () => {
      await loaded();

      fixture.componentInstance.reload();
      await fixture.whenStable();

      expect(fixture.componentInstance.canLoadMore()).toBe(false);
      controller.expectOne((r) => r.url === URL).flush(page(3, 'cursor-b'));
      await fixture.whenStable();
      expect(fixture.componentInstance.canLoadMore()).toBe(true);
    });

    it('keeps the rows when the restart fails, and Try again replaces them', async () => {
      await loaded();

      fixture.componentInstance.reload();
      controller.expectOne((r) => r.url === URL).flush(null, { status: 503, statusText: 'Unavailable' });
      await fixture.whenStable();

      expect(fixture.componentInstance.error()).not.toBeNull();
      expect(fixture.componentInstance.products()).toHaveLength(20);

      fixture.componentInstance.retryLoad();
      const retry = controller.expectOne((r) => r.url === URL);
      expect(retry.request.params.has('cursor')).toBe(false);
      retry.flush(page(3, null));
      await fixture.whenStable();

      expect(fixture.componentInstance.products()).toHaveLength(3);
      expect(fixture.componentInstance.error()).toBeNull();
    });
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

  describe('stock, list states and the link to a product', () => {
    const listing = () =>
      controller.expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products');

    /** One row per level, in order: p0 carries the first, p1 the second. */
    const stocked = (...levels: (number | null)[]) => ({
      items: levels.map((quantityAvailable, i) => ({
        ...page(1, null).items[0],
        productId: `p${i}`,
        name: `Product ${i}`,
        quantityAvailable,
      })),
      nextCursor: null,
    });

    const text = (): string => fixture.nativeElement.textContent ?? '';

    it('says in stock, how many are left, or out of stock, and nothing for never reported', async () => {
      listing().flush(stocked(40, 3, 0, null));
      await fixture.whenStable();

      const rows: string[] = [...fixture.nativeElement.querySelectorAll('ion-item')].map(
        (row: HTMLElement) => row.textContent ?? '',
      );
      expect(rows[0]).toContain('In stock');
      expect(rows[1]).toContain('Only 3 left');
      expect(rows[2]).toContain('Out of stock');
      expect(rows[3]).not.toMatch(/stock|left/i);
    });

    it('disables Add on an out-of-stock row, and refuses it if called anyway', async () => {
      listing().flush(stocked(0, null));
      await fixture.whenStable();

      const adds = [...fixture.nativeElement.querySelectorAll('ion-button')].filter(
        (b: HTMLElement) => b.textContent?.trim() === 'Add',
      );
      fixture.detectChanges();
      expect(adds[0].disabled).toBe(true);
      expect(adds[1].disabled).toBe(false);

      fixture.componentInstance.addToCart(fixture.componentInstance.products()[0]);
      expect(TestBed.inject(CartStore).count()).toBe(0);

      // Never reported is not none: that row still sells.
      fixture.componentInstance.addToCart(fixture.componentInstance.products()[1]);
      expect(TestBed.inject(CartStore).count()).toBe(1);
    });

    it('hands every level it receives to the cart through core', async () => {
      listing().flush(stocked(2, null));
      await fixture.whenStable();

      const availability = TestBed.inject(CatalogAvailability);
      expect(availability.of('p0')).toBe(2);
      expect(availability.of('p1')).toBeNull();
    });

    it('shows the skeleton while the first page is in flight, and not after', async () => {
      expect(fixture.componentInstance.showSkeleton()).toBe(true);
      expect(fixture.nativeElement.querySelector('app-skeleton-list')).not.toBeNull();

      listing().flush(stocked(1));
      await fixture.whenStable();

      expect(fixture.componentInstance.showSkeleton()).toBe(false);
      expect(fixture.nativeElement.querySelector('app-skeleton-list')).toBeNull();
    });

    it('says the catalogue is empty when the first page is empty and last', async () => {
      listing().flush({ items: [], nextCursor: null });
      await fixture.whenStable();

      expect(fixture.nativeElement.querySelector('app-empty-state')).not.toBeNull();
      expect(text()).toContain('Nothing published yet');
      expect(fixture.nativeElement.querySelector('[data-testid="end-of-list"]')).toBeNull();
    });

    it('does not call a failed first page empty', async () => {
      listing().flush({ title: 'Down' }, { status: 503, statusText: 'Unavailable' });
      await fixture.whenStable();

      expect(fixture.nativeElement.querySelector('app-empty-state')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-skeleton-list')).toBeNull();
    });

    it('marks the end only once the platform says there is no further page', async () => {
      listing().flush(page(2, 'cursor-2'));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('[data-testid="end-of-list"]')).toBeNull();

      fixture.componentInstance.loadMore();
      listing().flush(page(1, null));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('[data-testid="end-of-list"]')).not.toBeNull();
    });

    it('pull to refresh restarts from the first page and closes its spinner on the reply', async () => {
      listing().flush(page(2, 'cursor-2'));
      await fixture.whenStable();

      const complete = vi.fn();
      fixture.componentInstance.refresh({ target: { complete } });

      const fresh = listing();
      expect(fresh.request.params.has('cursor')).toBe(false);
      expect(complete).not.toHaveBeenCalled();

      fresh.flush(page(1, null));
      await fixture.whenStable();

      expect(complete).toHaveBeenCalledOnce();
      expect(fixture.componentInstance.products()).toHaveLength(1);
    });

    it("links each row to its product's own address", async () => {
      listing().flush(stocked(10, null));
      await fixture.whenStable();

      const links = [...fixture.nativeElement.querySelectorAll('a.open')].map((a: HTMLElement) =>
        a.getAttribute('href'),
      );
      expect(links).toEqual(['/tabs/products/p0', '/tabs/products/p1']);
    });
  });

  describe('search and sort (#106)', () => {
    const URL = 'http://localhost:5000/api/v1/catalog/products';
    const listing = () => controller.expectOne((r) => r.url === URL);

    beforeEach(async () => {
      listing().flush(page(20, 'cursor-2'));
      await fixture.whenStable();
    });

    it('restarts at the first page with the search, and asks later pages under it', async () => {
      fixture.componentInstance.onSearch('  lamp ');

      const first = listing();
      expect(first.request.params.get('q')).toBe('lamp');
      expect(first.request.params.has('cursor')).toBe(false);
      first.flush(page(20, 'lamp-2'));
      await fixture.whenStable();
      expect(fixture.componentInstance.products()).toHaveLength(20);

      fixture.componentInstance.loadMore();
      const next = listing();
      expect(next.request.params.get('q')).toBe('lamp');
      expect(next.request.params.get('cursor')).toBe('lamp-2');
      next.flush(page(1, null));
    });

    it('sends a sort the server names, and the default as no parameter', async () => {
      fixture.componentInstance.onSort('name');
      const byName = listing();
      expect(byName.request.params.get('sort')).toBe('name');
      byName.flush(page(2, null));
      await fixture.whenStable();

      fixture.componentInstance.onSort('newest');
      const newest = listing();
      expect(newest.request.params.has('sort')).toBe(false);
      newest.flush(page(2, null));
    });

    it('sends nothing for a sort outside the closed set, or for an unchanged control', () => {
      fixture.componentInstance.onSort('price');
      fixture.componentInstance.onSort('newest');
      fixture.componentInstance.onSearch('   ');

      controller.expectNone((r) => r.url === URL);
    });

    it('drops a page asked under the old search when the search changes', async () => {
      fixture.componentInstance.loadMore();
      const stale = listing();

      fixture.componentInstance.onSearch('lamp');
      const fresh = controller.expectOne((r) => r.url === URL && r.params.get('q') === 'lamp');

      stale.flush(page(20, 'old-3'));
      fresh.flush(page(1, null));
      await fixture.whenStable();

      expect(fixture.componentInstance.products()).toHaveLength(1);
      expect(fixture.componentInstance.hasMore()).toBe(false);
    });

    it('says when a search finds nothing, in words that name it', async () => {
      fixture.componentInstance.onSearch('no such thing');
      listing().flush(page(0, null));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('No results for “no such thing”');
      expect(fixture.nativeElement.textContent).not.toContain('Nothing published yet');
    });

    it('ends a search on "every match", and a cleared search on everything published', async () => {
      fixture.componentInstance.onSearch('lamp');
      listing().flush(page(1, null));
      await fixture.whenStable();
      fixture.detectChanges();
      const end = () =>
        fixture.nativeElement.querySelector('[data-testid="end-of-list"]').textContent.trim();
      expect(end()).toBe('That is every match.');

      fixture.componentInstance.onSearch('');
      const cleared = listing();
      expect(cleared.request.params.has('q')).toBe(false);
      cleared.flush(page(1, null));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(end()).toBe('That is everything published so far.');
    });

    it('holds a search made inside a closed window, and asks it once the window ends', async () => {
      fixture.componentInstance.loadMore();
      listing().flush(null, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '30' },
      });
      await fixture.whenStable();
      expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);

      fixture.componentInstance.onSearch('lamp');
      controller.expectNone((r) => r.url === URL);
      expect(fixture.componentInstance.search()).toBe('lamp');

      TestBed.inject(RateLimitWindows).forPartition('catalogue').close();
      await fixture.whenStable();

      const held = listing();
      expect(held.request.params.get('q')).toBe('lamp');
      expect(held.request.params.has('cursor')).toBe(false);
      held.flush(page(1, null));
    });

    it('cuts a search to the server’s own ceiling rather than sending one it refuses', () => {
      fixture.componentInstance.onSearch('x'.repeat(250));

      expect(listing().request.params.get('q')).toHaveLength(200);
    });
  });
});
