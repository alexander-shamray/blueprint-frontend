import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { DOCUMENT, WritableSignal, signal } from '@angular/core';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDetail } from '@core/api/types';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { OrderPlacedPage } from './order-placed.page';

const GUID_A = '44444444-4444-4444-4444-444444444444';
const GUID_B = '55555555-5555-5555-5555-555555555555';

const READ = 'http://localhost:5000/bff/v1/orders/';

function detail(orderId: string, status: string): OrderDetail {
  return {
    orderId,
    status,
    timeline: { placed: '2026-10-05T10:00:00Z', confirmed: null, dispatched: null, delivered: null, cancelled: null },
    refunded: false,
    refundedAt: null,
    cancellable: status === 'placed' || status === 'confirmed',
    total: { amount: 25, currency: 'EUR' },
    lines: [],
    asOf: '2026-10-05T10:00:01Z',
    payment: null,
    shipment: null,
  };
}

const demo: CurrentUser = { username: 'demo', subject: 'a', permissions: [], expiresAt: 0 };
const other: CurrentUser = { username: 'other', subject: 'b', permissions: [], expiresAt: 0 };

function mount(id: string, signedIn: CurrentUser | null = demo): {
  fixture: ComponentFixture<OrderPlacedPage>;
  paramMap: BehaviorSubject<string>;
  user: WritableSignal<CurrentUser | null>;
  controller: HttpTestingController;
} {
  TestBed.resetTestingModule();

  // A BehaviorSubject-backed paramMap, so a test can drive a second id
  // through the SAME ActivatedRoute, the way Angular's advanceActivatedRoute
  // does on a reused route.
  const paramMap = new BehaviorSubject(id);
  // One writable signal for the mount, so a test can sign somebody else in.
  const user: WritableSignal<CurrentUser | null> = signal(signedIn);

  TestBed.configureTestingModule({
    imports: [OrderPlacedPage],
    providers: [
      provideRouter([]),
      // The real interceptor, because the poll's 429 handling leans on the
      // window it opens.
      provideHttpClient(withInterceptors([rateLimitInterceptor])),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: () => user } },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => paramMap.value } },
          paramMap: paramMap.pipe(map((value) => convertToParamMap({ id: value }))),
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(OrderPlacedPage);
  fixture.detectChanges();
  return { fixture, paramMap, user, controller: TestBed.inject(HttpTestingController) };
}

/** Every read outstanding right now, which is how a test counts polls. */
function reads(controller: HttpTestingController) {
  return controller.match((r) => r.url.startsWith(READ));
}

function setVisibility(state: DocumentVisibilityState): void {
  const document = TestBed.inject(DOCUMENT);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('OrderPlacedPage', () => {
  let controller: HttpTestingController | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    controller?.verify();
    controller = undefined;
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('shows the order id, asks the order read for it at once, and links to tracking', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;

    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    const [first] = reads(controller);
    expect(first.request.url).toBe(`${READ}${GUID_A}`);
    first.flush(detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain('Placed');
    expect(mounted.fixture.nativeElement.textContent).toContain('Track this order');
    // Cancel moved to the tracking detail (#95): there is one cancel button, and it is not here.
    expect(mounted.fixture.nativeElement.textContent).not.toContain('Cancel order');
    // The sentence this page used to carry stopped being true when the read landed.
    expect(mounted.fixture.nativeElement.textContent).not.toContain('exposes no endpoint');
  });

  it('backs off from 3 seconds towards 15 while the status is not terminal', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));

    // `match` removes what it returns, so each second's look is kept and
    // answered rather than taken twice.
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      let waited = 0;
      let found = reads(controller);
      while (found.length === 0) {
        vi.advanceTimersByTime(1_000);
        waited += 1_000;
        if (waited > 60_000) throw new Error('no poll within a minute');
        found = reads(controller);
      }
      gaps.push(waited);
      found[0].flush(detail(GUID_A, 'confirmed'));
    }

    expect(gaps).toEqual([3_000, 6_000, 12_000, 15_000]);
    mounted.fixture.destroy();
  });

  it('stops on a terminal status and asks nothing more', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'out_of_stock'));
    mounted.fixture.detectChanges();

    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);
    expect(mounted.fixture.nativeElement.textContent).toContain('Out of stock');
    expect(mounted.fixture.nativeElement.textContent).toContain('reached its last status');
  });

  it('reads a 404 as not recorded yet and keeps polling, rather than reporting a missing order', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(
      { title: 'Not Found', status: 404, detail: 'No order with that id.' },
      { status: 404, statusText: 'Not Found' },
    );
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(mounted.fixture.nativeElement.textContent).toContain('has not recorded this order yet');

    vi.advanceTimersByTime(3_000);
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('stops while the page is hidden and resumes when it is shown again', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));

    setVisibility('hidden');
    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);

    setVisibility('visible');
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('stops when Ionic reports the page is being left, and resumes on entry', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));

    // A tab switch leaves a pushed page standing, so this is the hook that
    // fires there — not ngOnDestroy.
    mounted.fixture.componentInstance.ionViewWillLeave();
    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);

    mounted.fixture.componentInstance.ionViewWillEnter();
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('cancels a read in flight when the page is left', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const [pending] = reads(controller);

    mounted.fixture.componentInstance.ionViewWillLeave();
    expect(pending.cancelled).toBe(true);
  });

  it('stretches the interval on a 429 to a poll rather than raising a banner', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(
      { title: 'Too many requests', status: 429 },
      { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '20' } },
    );
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.rateLimit.blocked()).toBe(true);
    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(mounted.fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();

    // Nothing inside the window the gateway named.
    vi.advanceTimersByTime(19_000);
    expect(reads(controller)).toEqual([]);

    vi.advanceTimersByTime(2_000);
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('sends no poll into an authenticated window another request opened', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));

    // Opened by somebody else's 429 — quote, checkout, History — so the poll's
    // own stretch plays no part, and only the page's guard can hold it.
    const windows = TestBed.inject(RateLimitWindows);
    windows.forPartition('authenticated').open({
      kind: 'rateLimited',
      title: 'Too many requests',
      detail: null,
      retryAfterSeconds: 30,
    });
    expect(mounted.fixture.componentInstance.rateLimit.blocked()).toBe(true);

    // The 3-second poll falls due inside the window and is held.
    vi.advanceTimersByTime(29_000);
    expect(reads(controller)).toEqual([]);

    // And it goes once the window is over, rather than never.
    vi.advanceTimersByTime(8_000);
    const after = reads(controller);
    expect(after.length).toBe(1);
    after[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('stops and says so on a 401, which no later poll could change', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(
      { title: 'Unauthorized', status: 401 },
      { status: 401, statusText: 'Unauthorized' },
    );
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'signIn' });
    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);
  });

  it('drops a poll reply for the prior order when the route hands this instance a new :id', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const [forA] = reads(controller);

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();

    // A's read was cancelled with the restart, and B's went out in its place.
    expect(forA.cancelled).toBe(true);
    const [forB] = reads(controller);
    expect(forB.request.url).toBe(`${READ}${GUID_B}`);
    forB.flush(detail(GUID_B, 'delivered'));
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_B);
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    expect(mounted.fixture.componentInstance.status()).toBe('delivered');
  });

  it('does not let a status for order A stand under order B', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'cancelled'));
    expect(mounted.fixture.componentInstance.status()).toBe('cancelled');

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.status()).toBeNull();
    reads(controller)[0].flush(detail(GUID_B, 'placed'));
    mounted.fixture.destroy();
  });

  it('polls nothing for the already-committed sentinel and points at History instead', () => {
    const mounted = mount('already-committed');
    controller = mounted.controller;

    vi.advanceTimersByTime(60_000);
    expect(reads(controller)).toEqual([]);

    const text: string = mounted.fixture.nativeElement.textContent;
    expect(text).toContain('Already committed');
    expect(text).toContain('already been applied');
    expect(text).toContain('Open History');
    // No order id came back, so neither the sentinel nor a real id belongs on screen.
    expect(text).not.toContain('already-committed');
  });

  it('shows and polls nothing of the order while somebody else is signed in', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    expect(mounted.fixture.componentInstance.status()).toBe('placed');

    mounted.user.set(other);
    mounted.fixture.detectChanges();

    const text: string = mounted.fixture.nativeElement.textContent;
    expect(mounted.fixture.componentInstance.status()).toBeNull();
    expect(text).not.toContain(GUID_A);
    expect(text).not.toContain('Track this order');
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="foreign"]')).not.toBeNull();

    // Not a 404 at the back-off cap on their budget: no read at all.
    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);
    mounted.fixture.destroy();
  });

  it('starts the poll from nothing when the buyer it is for signs in again', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'confirmed'));

    // Signed out, then somebody else, then the first buyer back.
    mounted.user.set(null);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    mounted.user.set(other);
    mounted.fixture.detectChanges();
    vi.advanceTimersByTime(60_000);
    expect(reads(controller)).toEqual([]);

    mounted.user.set(demo);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.status()).toBeNull();

    // At once rather than on the old back-off.
    reads(controller)[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.status()).toBe('placed');
    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    mounted.fixture.destroy();
  });

  it('shows and polls nothing while built signed out, then belongs to the first buyer in', () => {
    // A web reload of the URL with no session: the route is unguarded.
    const mounted = mount(GUID_A, null);
    controller = mounted.controller;

    vi.advanceTimersByTime(60_000);
    expect(reads(controller)).toEqual([]);
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="foreign"]')).not.toBeNull();

    mounted.user.set(demo);
    mounted.fixture.detectChanges();

    const after = reads(controller);
    expect(after.length).toBe(1);
    expect(after[0].request.url).toBe(`${READ}${GUID_A}`);
    after[0].flush(detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    mounted.fixture.destroy();
  });

  it('lets a 404 clear a status an earlier read reported, rather than stand beside it', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(detail(GUID_A, 'placed'));

    vi.advanceTimersByTime(3_000);
    reads(controller)[0].flush(
      { title: 'Not Found', status: 404 },
      { status: 404, statusText: 'Not Found' },
    );

    expect(mounted.fixture.componentInstance.status()).toBeNull();
    mounted.fixture.destroy();
  });

  it('lets the latest answer decide the note: a 404 after a failed read says not recorded', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(null, { status: 503, statusText: 'Service Unavailable' });
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain('could not be read just now');

    vi.advanceTimersByTime(3_000);
    reads(controller)[0].flush(
      { title: 'Not Found', status: 404 },
      { status: 404, statusText: 'Not Found' },
    );
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).not.toContain('could not be read just now');
    expect(mounted.fixture.nativeElement.textContent).toContain('has not recorded this order yet');
    mounted.fixture.destroy();
  });

  it('resumes after a 401 on the next entry once a session is back, and not after a 403', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    reads(controller)[0].flush(
      { title: 'Unauthorized', status: 401 },
      { status: 401, statusText: 'Unauthorized' },
    );
    vi.advanceTimersByTime(120_000);
    expect(reads(controller)).toEqual([]);

    // Away to sign in on Account and back: the same buyer, with a session again.
    mounted.fixture.componentInstance.ionViewWillLeave();
    mounted.fixture.componentInstance.ionViewWillEnter();
    expect(mounted.fixture.componentInstance.error()).toBeNull();

    reads(controller)[0].flush(
      { title: 'Forbidden', status: 403 },
      { status: 403, statusText: 'Forbidden' },
    );
    mounted.fixture.componentInstance.ionViewWillLeave();
    mounted.fixture.componentInstance.ionViewWillEnter();

    expect(reads(controller)).toEqual([]);
    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'forbidden' });
  });
});
