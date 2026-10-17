import { HttpEventType, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController, TestRequest, provideHttpClientTesting,
} from '@angular/common/http/testing';
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
      // The real interceptor, because the 429 handling leans on the window it
      // opens.
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

/** Every stream request outstanding right now, which is how a test counts openings. */
function streams(controller: HttpTestingController): TestRequest[] {
  return controller.match((r) => r.url.startsWith(READ) && r.url.endsWith('/events'));
}

/** What each request has been sent so far: a progress event carries the text whole. */
const sent = new WeakMap<TestRequest, string>();

/** The server writes an `order` event on a stream that stays open. */
function emit(request: TestRequest, order: OrderDetail): void {
  const text = `${sent.get(request) ?? ''}id: ${order.asOf}\nevent: order\ndata: ${JSON.stringify(order)}\n\n`;
  sent.set(request, text);
  request.event({ type: HttpEventType.DownloadProgress, loaded: text.length, partialText: text });
}

/** The server ends the stream, having written what `emit` did. */
function end(request: TestRequest): void {
  request.flush(sent.get(request) ?? '');
}

/** The first stream is opened, answers `order`, and stays open. */
function openWith(controller: HttpTestingController, order: OrderDetail): TestRequest {
  const [request] = streams(controller);
  emit(request, order);
  return request;
}

function fail(request: TestRequest, status: number, statusText: string, headers: Record<string, string> = {}): void {
  request.flush(JSON.stringify({ title: statusText, status }), { status, statusText, headers });
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

  it('shows the order id, opens the order stream at once, and links to tracking', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;

    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    const [first] = streams(controller);
    expect(first.request.url).toBe(`${READ}${GUID_A}/events`);
    expect(first.request.headers.get('Accept')).toBe('text/event-stream');
    emit(first, detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain('Placed');
    expect(mounted.fixture.nativeElement.textContent).toContain('Track this order');
    // Cancel moved to the tracking detail (#95): there is one cancel button, and it is not here.
    expect(mounted.fixture.nativeElement.textContent).not.toContain('Cancel order');
    // The sentence this page used to carry stopped being true when the read landed.
    expect(mounted.fixture.nativeElement.textContent).not.toContain('exposes no endpoint');
    mounted.fixture.destroy();
  });

  it('follows every change on the one stream, and opens no second while it is open', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'placed'));
    expect(mounted.fixture.componentInstance.status()).toBe('placed');

    emit(stream, detail(GUID_A, 'confirmed'));
    expect(mounted.fixture.componentInstance.status()).toBe('confirmed');
    emit(stream, detail(GUID_A, 'dispatched'));
    expect(mounted.fixture.componentInstance.status()).toBe('dispatched');

    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
    mounted.fixture.destroy();
  });

  it('closes the stream on a terminal status and opens nothing more', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'delivered'));
    mounted.fixture.detectChanges();

    expect(stream.cancelled).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
    expect(mounted.fixture.nativeElement.textContent).toContain('Delivered');
    expect(mounted.fixture.nativeElement.textContent).toContain('reached its last status');
  });

  it('does not open it again when the server ends it after a delivery', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const [stream] = streams(controller);
    // The final response lands with the event, before this page has acted.
    stream.flush(`id: t\nevent: order\ndata: ${JSON.stringify(detail(GUID_A, 'delivered'))}\n\n`);

    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
    expect(mounted.fixture.componentInstance.status()).toBe('delivered');
  });

  it('keeps following after a cancellation, which a later delivery outranks (#158)', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'cancelled'));
    mounted.fixture.detectChanges();

    expect(stream.cancelled).toBe(false);
    emit(stream, detail(GUID_A, 'delivered'));
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.status()).toBe('delivered');
    expect(mounted.fixture.nativeElement.textContent).toContain('reached its last status');
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
  });

  it('opens the stream again after the server ends it, naming the last event it holds', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'confirmed'));
    end(stream);

    vi.advanceTimersByTime(2_999);
    expect(streams(controller)).toEqual([]);
    vi.advanceTimersByTime(1);
    const [again] = streams(controller);
    expect(again.request.headers.get('Last-Event-ID')).toBe('2026-10-05T10:00:01Z');
    // The status stays on screen across the gap: nothing contradicted it.
    expect(mounted.fixture.componentInstance.status()).toBe('confirmed');
    mounted.fixture.destroy();
  });

  it('backs off from 3 seconds towards 15 while no stream can be opened', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 503, 'Service Unavailable');

    // `match` removes what it returns, so each second's look is kept and
    // answered rather than taken twice.
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      let waited = 0;
      let found = streams(controller);
      while (found.length === 0) {
        vi.advanceTimersByTime(1_000);
        waited += 1_000;
        if (waited > 60_000) throw new Error('no stream within a minute');
        found = streams(controller);
      }
      gaps.push(waited);
      fail(found[0], 503, 'Service Unavailable');
    }

    expect(gaps).toEqual([3_000, 6_000, 12_000, 15_000]);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain('could not be reached just now');
    mounted.fixture.destroy();
  });

  it('starts the back-off again once a stream has delivered something', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 503, 'Service Unavailable');
    vi.advanceTimersByTime(3_000);
    fail(streams(controller)[0], 503, 'Service Unavailable');
    vi.advanceTimersByTime(6_000);
    end(openWith(controller, detail(GUID_A, 'placed')));

    // Not the 12 seconds the third failure would have waited.
    vi.advanceTimersByTime(3_000);
    expect(streams(controller)).toHaveLength(1);
    mounted.fixture.destroy();
  });

  it('reads a 404 as not recorded yet and tries again, rather than reporting a missing order', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 404, 'Not Found');
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(mounted.fixture.nativeElement.textContent).toContain('has not recorded this order yet');

    vi.advanceTimersByTime(3_000);
    emit(streams(controller)[0], detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('closes the stream while the page is hidden and opens it again when it is shown', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'placed'));

    setVisibility('hidden');
    expect(stream.cancelled).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);

    setVisibility('visible');
    emit(streams(controller)[0], detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('closes the stream when Ionic reports the page is being left, and opens it on entry', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'placed'));

    // A tab switch leaves a pushed page standing, so this is the hook that
    // fires there — not ngOnDestroy.
    mounted.fixture.componentInstance.ionViewWillLeave();
    expect(stream.cancelled).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);

    mounted.fixture.componentInstance.ionViewWillEnter();
    emit(streams(controller)[0], detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('closes a stream still being opened when the page is left', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const [pending] = streams(controller);

    mounted.fixture.componentInstance.ionViewWillLeave();
    expect(pending.cancelled).toBe(true);
  });

  it('closes the stream when the page is destroyed', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const stream = openWith(controller, detail(GUID_A, 'placed'));

    mounted.fixture.destroy();

    expect(stream.cancelled).toBe(true);
  });

  it('stretches the wait on a 429 to a stream rather than raising a banner', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 429, 'Too Many Requests', { 'Retry-After': '20' });
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.rateLimit.blocked()).toBe(true);
    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(mounted.fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();

    // Nothing inside the window the gateway named.
    vi.advanceTimersByTime(19_000);
    expect(streams(controller)).toEqual([]);

    vi.advanceTimersByTime(2_000);
    emit(streams(controller)[0], detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('opens no stream into an authenticated window another request opened', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    end(openWith(controller, detail(GUID_A, 'placed')));

    // Opened by somebody else's 429 — quote, checkout, History — so this
    // page's own stretch plays no part, and only its guard can hold it.
    const windows = TestBed.inject(RateLimitWindows);
    windows.forPartition('authenticated').open({
      kind: 'rateLimited',
      title: 'Too many requests',
      detail: null,
      retryAfterSeconds: 30,
    });
    expect(mounted.fixture.componentInstance.rateLimit.blocked()).toBe(true);

    // The 3-second reopening falls due inside the window and is held.
    vi.advanceTimersByTime(29_000);
    expect(streams(controller)).toEqual([]);

    // And it goes once the window is over, rather than never.
    vi.advanceTimersByTime(8_000);
    const after = streams(controller);
    expect(after.length).toBe(1);
    emit(after[0], detail(GUID_A, 'placed'));
    mounted.fixture.destroy();
  });

  it('stops and says so on a 401, which no later attempt could change', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 401, 'Unauthorized');
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'signIn' });
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
  });

  it('drops a stream for the prior order when the route hands this instance a new :id', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const [forA] = streams(controller);

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();

    // A's stream was closed with the restart, and B's opened in its place.
    expect(forA.cancelled).toBe(true);
    const [forB] = streams(controller);
    expect(forB.request.url).toBe(`${READ}${GUID_B}/events`);
    emit(forB, detail(GUID_B, 'delivered'));
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_B);
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    expect(mounted.fixture.componentInstance.status()).toBe('delivered');
  });

  it('does not let a status for order A stand under order B, or name its event to B', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    openWith(controller, detail(GUID_A, 'cancelled'));
    expect(mounted.fixture.componentInstance.status()).toBe('cancelled');

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.status()).toBeNull();
    const [forB] = streams(controller);
    expect(forB.request.headers.has('Last-Event-ID')).toBe(false);
    emit(forB, detail(GUID_B, 'placed'));
    mounted.fixture.destroy();
  });

  it('opens no stream for the already-committed sentinel and points at History instead', () => {
    const mounted = mount('already-committed');
    controller = mounted.controller;

    vi.advanceTimersByTime(60_000);
    expect(streams(controller)).toEqual([]);

    const text: string = mounted.fixture.nativeElement.textContent;
    expect(text).toContain('Already committed');
    expect(text).toContain('already been applied');
    expect(text).toContain('Open History');
    // No order id came back, so neither the sentinel nor a real id belongs on screen.
    expect(text).not.toContain('already-committed');
  });

  it('shows and opens nothing of the order while somebody else is signed in', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    openWith(controller, detail(GUID_A, 'placed'));
    expect(mounted.fixture.componentInstance.status()).toBe('placed');

    mounted.user.set(other);
    mounted.fixture.detectChanges();

    const text: string = mounted.fixture.nativeElement.textContent;
    expect(mounted.fixture.componentInstance.status()).toBeNull();
    expect(text).not.toContain(GUID_A);
    expect(text).not.toContain('Track this order');
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="foreign"]')).not.toBeNull();

    // Not a 404 at the back-off cap on their budget: no request at all.
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);
    mounted.fixture.destroy();
  });

  it('starts the stream from nothing when the buyer it is for signs in again', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    openWith(controller, detail(GUID_A, 'confirmed'));

    // Signed out, then somebody else, then the first buyer back.
    mounted.user.set(null);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    mounted.user.set(other);
    mounted.fixture.detectChanges();
    vi.advanceTimersByTime(60_000);
    expect(streams(controller)).toEqual([]);

    mounted.user.set(demo);
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.status()).toBeNull();

    // At once rather than on the old back-off, and without the old buyer's event id.
    const [again] = streams(controller);
    expect(again.request.headers.has('Last-Event-ID')).toBe(false);
    emit(again, detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.status()).toBe('placed');
    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    mounted.fixture.destroy();
  });

  it('shows and opens nothing while built signed out, then belongs to the first buyer in', () => {
    // A web reload of the URL with no session: the route is unguarded.
    const mounted = mount(GUID_A, null);
    controller = mounted.controller;

    vi.advanceTimersByTime(60_000);
    expect(streams(controller)).toEqual([]);
    expect(mounted.fixture.nativeElement.textContent).not.toContain(GUID_A);
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="foreign"]')).not.toBeNull();

    mounted.user.set(demo);
    mounted.fixture.detectChanges();

    const after = streams(controller);
    expect(after.length).toBe(1);
    expect(after[0].request.url).toBe(`${READ}${GUID_A}/events`);
    emit(after[0], detail(GUID_A, 'placed'));
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain(GUID_A);
    mounted.fixture.destroy();
  });

  it('lets a 404 clear a status an earlier event reported, rather than stand beside it', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    end(openWith(controller, detail(GUID_A, 'placed')));

    vi.advanceTimersByTime(3_000);
    fail(streams(controller)[0], 404, 'Not Found');

    expect(mounted.fixture.componentInstance.status()).toBeNull();
    mounted.fixture.destroy();
  });

  it('lets the latest answer decide the note: a 404 after a failed open says not recorded', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 503, 'Service Unavailable');
    mounted.fixture.detectChanges();
    expect(mounted.fixture.nativeElement.textContent).toContain('could not be reached just now');

    vi.advanceTimersByTime(3_000);
    fail(streams(controller)[0], 404, 'Not Found');
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).not.toContain('could not be reached just now');
    expect(mounted.fixture.nativeElement.textContent).toContain('has not recorded this order yet');
    mounted.fixture.destroy();
  });

  it('resumes after a 401 on the next entry once a session is back, and not after a 403', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 401, 'Unauthorized');
    vi.advanceTimersByTime(120_000);
    expect(streams(controller)).toEqual([]);

    // Away to sign in on Account and back: the same buyer, with a session again.
    mounted.fixture.componentInstance.ionViewWillLeave();
    mounted.fixture.componentInstance.ionViewWillEnter();
    expect(mounted.fixture.componentInstance.error()).toBeNull();

    fail(streams(controller)[0], 403, 'Forbidden');
    mounted.fixture.componentInstance.ionViewWillLeave();
    mounted.fixture.componentInstance.ionViewWillEnter();

    expect(streams(controller)).toEqual([]);
    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'forbidden' });
  });

  it('resumes after a 401 when a renewed token arrives for the same subject (#156)', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 401, 'Unauthorized');
    mounted.fixture.detectChanges();
    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'signIn' });

    // The native renewal lands: same buyer, a later expiry.
    mounted.user.set({ ...demo, expiresAt: 1_800_000_000 });
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(streams(controller)).toHaveLength(1);
    mounted.fixture.destroy();
  });

  it('lifts a sign-in stop when the page becomes visible again (#156)', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 401, 'Unauthorized');
    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'signIn' });

    setVisibility('hidden');
    setVisibility('visible');

    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(streams(controller)).toHaveLength(1);
    mounted.fixture.destroy();
  });

  it('does not lift a 403 on a renewed token (#156)', () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    fail(streams(controller)[0], 403, 'Forbidden');

    mounted.user.set({ ...demo, expiresAt: 1_800_000_000 });
    mounted.fixture.detectChanges();

    expect(streams(controller)).toEqual([]);
    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'forbidden' });
    mounted.fixture.destroy();
  });
});
