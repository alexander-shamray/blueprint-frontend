import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WritableSignal, signal } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderSummary } from '@core/api/types';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { OrdersPage } from './orders.page';

const LIST = 'http://localhost:5000/bff/v1/orders';

function summary(orderId: string, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    orderId,
    status: 'placed',
    timeline: { placed: '2026-10-05T10:00:00Z', confirmed: null, dispatched: null, delivered: null, cancelled: null },
    refunded: false,
    refundedAt: null,
    cancellable: true,
    total: { amount: 25, currency: 'EUR' },
    lines: [{ productId: 'p1', productName: 'Kettle', lineTotal: { amount: 25, currency: 'EUR' } }],
    asOf: '2026-10-05T10:00:01Z',
    ...overrides,
  };
}

const demo: CurrentUser = { username: 'demo', subject: 'a', permissions: [], expiresAt: 0 };

function mount(user: WritableSignal<CurrentUser | null> = signal(demo)) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [OrdersPage],
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([rateLimitInterceptor])),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: () => user } },
    ],
  });

  const fixture: ComponentFixture<OrdersPage> = TestBed.createComponent(OrdersPage);
  fixture.detectChanges();
  return { fixture, user, controller: TestBed.inject(HttpTestingController) };
}

function list(controller: HttpTestingController) {
  return controller.expectOne((r) => r.url === LIST);
}

describe('OrdersPage', () => {
  let controller: HttpTestingController | undefined;

  afterEach(() => {
    controller?.verify();
    controller = undefined;
  });

  it('asks for nothing until Ionic reports an entry, then reads the first page', () => {
    const mounted = mount();
    controller = mounted.controller;
    controller.expectNone((r) => r.url === LIST);

    mounted.fixture.componentInstance.ionViewWillEnter();
    const request = list(controller);
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [summary('o1')], nextCursor: null });
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain('Kettle');
    expect(mounted.fixture.nativeElement.textContent).toContain('Placed');
  });

  it('reads again on every entry, so an order placed elsewhere appears without a restart', () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: null });

    // The tab root is cached, never rebuilt: arriving is the only trigger.
    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [summary('o2'), summary('o1')], nextCursor: null });

    expect(mounted.fixture.componentInstance.orders().map((o) => o.orderId)).toEqual(['o2', 'o1']);
  });

  it('pages on with the cursor and stops at a null nextCursor', () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: 'c1' });
    expect(mounted.fixture.componentInstance.canLoadMore()).toBe(true);

    mounted.fixture.componentInstance.loadMore();
    const second = list(controller);
    expect(second.request.params.get('cursor')).toBe('c1');
    second.flush({ items: [summary('o2')], nextCursor: null });
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.canLoadMore()).toBe(false);
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="end-of-list"]')).not.toBeNull();
  });

  it('says there are no orders yet, rather than drawing a blank list', () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [], nextCursor: null });
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain('No orders yet');
  });

  it('drops a page that a later entry superseded', () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.fixture.componentInstance.ionViewWillEnter();
    const stale = list(controller);
    mounted.fixture.componentInstance.ionViewWillEnter();
    const fresh = controller.match((r) => r.url === LIST);
    expect(fresh.length).toBe(1);

    fresh[0].flush({ items: [summary('o2')], nextCursor: null });
    stale.flush({ items: [summary('o1')], nextCursor: null });

    expect(mounted.fixture.componentInstance.orders().map((o) => o.orderId)).toEqual(['o2']);
  });

  it("forgets one buyer's history the moment the subject changes", () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: null });
    expect(mounted.fixture.componentInstance.orders().length).toBe(1);

    mounted.user.set(null);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.orders()).toEqual([]);
  });

  it("forgets the other buyer's history when the first one comes back", () => {
    const mounted = mount();
    controller = mounted.controller;

    mounted.user.set({ ...demo, username: 'other', subject: 'b' });
    mounted.fixture.detectChanges();
    mounted.fixture.componentInstance.ionViewWillEnter();
    list(controller).flush({ items: [summary('theirs')], nextCursor: null });
    expect(mounted.fixture.componentInstance.orders().map((o) => o.orderId)).toEqual(['theirs']);

    // Back to the subject this page was built for, without passing through null.
    mounted.user.set(demo);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.orders()).toEqual([]);
  });

  it('names an unresolved product and an order with no priced lines yet', () => {
    const mounted = mount();
    controller = mounted.controller;
    const page = mounted.fixture.componentInstance;

    expect(
      page.headline(
        summary('o1', {
          lines: [{ productId: 'p', productName: null, lineTotal: { amount: 1, currency: 'EUR' } }],
        }),
      ),
    ).toBe('Unnamed product');
    expect(page.headline(summary('o2', { lines: [], total: null }))).toBe(
      'Order details not recorded yet',
    );
  });

  it('shows a failed load with Try again, which resumes at the page that failed', () => {
    const mounted = mount();
    controller = mounted.controller;
    const page = mounted.fixture.componentInstance;

    // The second page fails, so a retry that started over from page one is
    // told apart by its cursor and by the rows it would have dropped.
    page.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: 'c1' });
    page.loadMore();
    list(controller).flush(null, { status: 503, statusText: 'Service Unavailable' });
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain('Try again');

    page.retryLoad();
    const retried = list(controller);
    expect(retried.request.params.get('cursor')).toBe('c1');
    retried.flush({ items: [summary('o2')], nextCursor: null });

    expect(page.orders().map((o) => o.orderId)).toEqual(['o1', 'o2']);
    expect(page.error()).toBeNull();
  });

  it('reads nothing on an entry inside an open authenticated window, and keeps its list', () => {
    const mounted = mount();
    controller = mounted.controller;
    const page = mounted.fixture.componentInstance;

    page.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: null });

    // Opened by another request on the same bucket, as a quote's 429 would.
    const authenticated = TestBed.inject(RateLimitWindows).forPartition('authenticated');
    authenticated.open({
      kind: 'rateLimited',
      title: 'Too many requests',
      detail: null,
      retryAfterSeconds: 30,
    });

    page.ionViewWillEnter();
    controller.expectNone((r) => r.url === LIST);
    expect(page.orders().map((o) => o.orderId)).toEqual(['o1']);

    // Once it closes, arriving reads again.
    authenticated.close();
    page.ionViewWillEnter();
    list(controller).flush({ items: [summary('o1')], nextCursor: null });
  });

  it('offers Try again after a first entry skipped into a blocked window, once it ends', () => {
    const mounted = mount();
    controller = mounted.controller;
    const page = mounted.fixture.componentInstance;
    const retry = (): HTMLElement & { disabled: boolean } =>
      [...mounted.fixture.nativeElement.querySelectorAll('ion-button')].find(
        (el: HTMLElement) => el.textContent?.trim() === 'Try again',
      );

    // Before any entry there is nothing to retry, so nothing is offered.
    expect(retry()).toBeUndefined();

    const authenticated = TestBed.inject(RateLimitWindows).forPartition('authenticated');
    authenticated.open({
      kind: 'rateLimited',
      title: 'Too many requests',
      detail: null,
      retryAfterSeconds: 30,
    });

    page.ionViewWillEnter();
    controller.expectNone((r) => r.url === LIST);
    mounted.fixture.detectChanges();
    expect(retry()).toBeTruthy();
    expect(retry().disabled).toBe(true);

    // The window ends with no further entry: the page is not left blank.
    authenticated.close();
    mounted.fixture.detectChanges();
    expect(retry().disabled).toBe(false);

    retry().click();
    const request = list(controller);
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [summary('o1')], nextCursor: null });
    mounted.fixture.detectChanges();

    expect(page.orders().map((o) => o.orderId)).toEqual(['o1']);
    expect(retry()).toBeUndefined();
  });
});
