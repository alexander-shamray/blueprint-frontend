import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderDetail } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { OrderDetailPage, timelineOf } from './order-detail.page';

const GUID_A = '44444444-4444-4444-4444-444444444444';
const GUID_B = '55555555-5555-5555-5555-555555555555';
const READ = 'http://localhost:5000/bff/v1/orders/';

function order(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    orderId: GUID_A,
    status: 'placed',
    timeline: { placed: '2026-10-05T10:00:00Z', confirmed: null, dispatched: null, delivered: null, cancelled: null },
    refunded: false,
    refundedAt: null,
    cancellable: true,
    total: { amount: 25, currency: 'EUR' },
    lines: [
      {
        productId: 'p1',
        productName: 'Kettle',
        lineTotal: { amount: 25, currency: 'EUR' },
        quantity: 2,
        unitPrice: { amount: 12.5, currency: 'EUR' },
      },
    ],
    asOf: '2026-10-05T10:00:01Z',
    payment: null,
    shipment: null,
    ...overrides,
  };
}

let signIn: ReturnType<typeof vi.fn>;

function mount(id: string) {
  TestBed.resetTestingModule();
  const paramMap = new BehaviorSubject(id);
  signIn = vi.fn(async () => undefined);

  TestBed.configureTestingModule({
    imports: [OrderDetailPage],
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([rateLimitInterceptor])),
      provideHttpClientTesting(),
      {
        provide: AuthService,
        useValue: { signIn, user: () => signal({ username: 'demo' }), accessToken: () => 't' },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => paramMap.value } },
          paramMap: paramMap.pipe(map((value) => convertToParamMap({ id: value }))),
        },
      },
    ],
  });

  const fixture: ComponentFixture<OrderDetailPage> = TestBed.createComponent(OrderDetailPage);
  fixture.detectChanges();
  const controller = TestBed.inject(HttpTestingController);
  return { fixture, paramMap, controller };
}

/** Mounts, answers the first read with `body`, and renders. */
async function mountWith(body: OrderDetail) {
  const mounted = mount(body.orderId);
  mounted.controller.expectOne(`${READ}${body.orderId}`).flush(body);
  await mounted.fixture.whenStable();
  mounted.fixture.detectChanges();
  return mounted;
}

function cancelButton(fixture: ComponentFixture<OrderDetailPage>): HTMLElement | undefined {
  return [...fixture.nativeElement.querySelectorAll('ion-button')].find(
    (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
  );
}

describe('timelineOf', () => {
  it('draws every forward step of a moving order, the unreached ones as not reached', () => {
    const steps = timelineOf(order());

    expect(steps.map((s) => s.key)).toEqual(['placed', 'confirmed', 'dispatched', 'delivered']);
    expect(steps.map((s) => s.at)).toEqual(['2026-10-05T10:00:00Z', null, null, null]);
  });

  it('draws an unhappy ending as the last step of a finished timeline, not as more steps to come', () => {
    const steps = timelineOf(
      order({
        status: 'declined',
        timeline: { placed: 't1', confirmed: null, dispatched: null, delivered: null, cancelled: 't2' },
      }),
    );

    expect(steps).toEqual([
      { key: 'placed', label: 'Placed', at: 't1', ending: false },
      { key: 'declined', label: 'Payment declined', at: 't2', ending: true },
    ]);
  });

  it('keeps a despatch the cancellation outranked, since both are facts (§10.7)', () => {
    const steps = timelineOf(
      order({
        status: 'cancelled',
        timeline: { placed: 't1', confirmed: 't2', dispatched: 't3', delivered: null, cancelled: 't4' },
      }),
    );

    expect(steps.map((s) => s.key)).toEqual(['placed', 'confirmed', 'dispatched', 'cancelled']);
  });

  it('appends a refund after the ending it followed, beside the status rather than as one', () => {
    const steps = timelineOf(
      order({
        status: 'out_of_stock',
        refunded: true,
        refundedAt: 't9',
        timeline: { placed: 't1', confirmed: null, dispatched: null, delivered: null, cancelled: 't2' },
      }),
    );

    expect(steps.at(-1)).toEqual({ key: 'refunded', label: 'Refunded', at: 't9', ending: true });
    expect(steps.at(-2)?.key).toBe('out_of_stock');
  });
});

describe('OrderDetailPage', () => {
  let controller: HttpTestingController | undefined;

  afterEach(() => {
    controller?.verify();
    controller = undefined;
  });

  it('reads the order by id and renders lines, total and the BFF timestamp it is as of', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    const text: string = mounted.fixture.nativeElement.textContent;
    expect(text).toContain(GUID_A);
    expect(text).toContain('Kettle');
    expect(text).toContain('Not reached yet');
    expect(text).toContain('As the platform last recorded it');
  });

  it('names a line whose product name never resolved, rather than dropping it', async () => {
    const mounted = await mountWith(
      order({
        lines: [
          {
            productId: 'p1',
            productName: null,
            lineTotal: { amount: 5, currency: 'EUR' },
            quantity: 1,
            unitPrice: { amount: 5, currency: 'EUR' },
          },
        ],
      }),
    );
    controller = mounted.controller;

    expect(mounted.fixture.nativeElement.textContent).toContain('Unnamed product');
  });

  it('says why there is no Cancel after despatch, before anyone tries', async () => {
    const mounted = await mountWith(order({ status: 'dispatched', cancellable: false }));
    controller = mounted.controller;

    expect(cancelButton(mounted.fixture)).toBeUndefined();
    expect(
      mounted.fixture.nativeElement.querySelector('[data-testid="cannot-cancel"]').textContent,
    ).toContain('dispatched, so it can no longer be cancelled');
  });

  it('offers nothing and explains nothing more for an order that has already ended', async () => {
    const mounted = await mountWith(
      order({
        status: 'cancelled',
        cancellable: false,
        timeline: {
          placed: '2026-10-05T10:00:00Z',
          confirmed: null,
          dispatched: null,
          delivered: null,
          cancelled: '2026-10-05T10:05:00Z',
        },
      }),
    );
    controller = mounted.controller;

    expect(cancelButton(mounted.fixture)).toBeUndefined();
    expect(mounted.fixture.nativeElement.querySelector('[data-testid="cannot-cancel"]')).toBeNull();
  });

  it('shows the 404 the backend sends for an order this buyer cannot see, with Try again', async () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    controller
      .expectOne(`${READ}${GUID_A}`)
      .flush(
        { title: 'Not Found', status: 404, detail: 'No order with that id.' },
        { status: 404, statusText: 'Not Found' },
      );
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    expect(mounted.fixture.nativeElement.textContent).toContain('No order with that id.');
    expect(mounted.fixture.nativeElement.textContent).toContain('Try again');
  });

  it('sends customer_request and offers no other reason, via the rendered Cancel button', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    cancelButton(mounted.fixture)?.click();

    // The other four codes are the platform's own findings — the saga's stock
    // outcomes and Payments' results. A customer cannot truthfully assert any
    // of them, and the endpoint stamps origin User whatever arrives.
    const request = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(request.request.url).toBe(`http://localhost:5000/api/v1/orders/${GUID_A}/cancel`);
    expect(request.request.body).toEqual({ reason: 'customer_request' });
    expect(mounted.fixture.nativeElement.querySelector('ion-select')).toBeNull();

    request.flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne(`${READ}${GUID_A}`).flush(order());
  });

  it('reports the 204, clears a prior error, and reads the order again', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    expect(mounted.fixture.componentInstance.error()).not.toBeNull();

    mounted.fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });

    // The projection lags the command, so the re-read may still say placed.
    controller.expectOne(`${READ}${GUID_A}`).flush(order());
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.cancelled()).toBe(true);
    expect(mounted.fixture.componentInstance.error()).toBeNull();
    expect(mounted.fixture.nativeElement.textContent).toContain('the platform answered 204');
    expect(cancelButton(mounted.fixture)).toBeUndefined();
  });

  it('guards a second tap while a cancel is in flight — no commandId here to replay under', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    mounted.fixture.componentInstance.cancel();

    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne(`${READ}${GUID_A}`).flush(order());
  });

  it('maps a 403 to a banner naming orders:cancel', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });

    expect(mounted.fixture.componentInstance.error()).toMatchObject({
      kind: 'forbidden',
      permission: 'orders:cancel',
    });
  });

  it('shows the platform its own 422 when the hint said cancellable and the command disagreed', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller.expectOne((r) => r.url.endsWith('/cancel')).flush(
      { title: 'Order already shipped', status: 422, detail: 'The order has shipped.', code: 'order.already_shipped' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.error()).toMatchObject({ kind: 'rule' });
    expect(mounted.fixture.nativeElement.textContent).toContain('The order has shipped.');
  });

  it('invokes sign-in on a 401 and replays the cancellation for the same order', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await mounted.fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
    const replay = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(replay.request.url).toContain(GUID_A);
    expect(replay.request.body).toEqual({ reason: 'customer_request' });

    replay.flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne(`${READ}${GUID_A}`).flush(order());
    expect(mounted.fixture.componentInstance.cancelled()).toBe(true);
  });

  it('does not replay a cancellation onto a different order the route handed this instance', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();
    controller.expectOne(`${READ}${GUID_B}`).flush(order({ orderId: GUID_B }));
    await mounted.fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
    controller.expectNone((r) => r.url.endsWith('/cancel'));
  });

  it('disables Cancel order while a 429 window is open', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    controller.expectOne((r) => r.url.endsWith('/cancel')).flush(
      { title: 'Too many requests', status: 429 },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.rateLimit.blocked()).toBe(true);
    expect((cancelButton(mounted.fixture) as HTMLElement & { disabled: boolean }).disabled).toBe(
      true,
    );
  });

  it('drops a cancel reply for the prior order when the route hands this instance a new :id', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    const forA = controller.expectOne((r) => r.url.endsWith('/cancel'));

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();
    controller.expectOne(`${READ}${GUID_B}`).flush(order({ orderId: GUID_B }));

    // A's 204 lands late. Applied, it would put the cancelled note under B.
    forA.flush(null, { status: 204, statusText: 'No Content' });
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    expect(mounted.fixture.componentInstance.cancelled()).toBe(false);
    expect(mounted.fixture.nativeElement.textContent).not.toContain('the platform answered 204');

    // And B's Cancel is live: the in-flight guard was released with the id change.
    mounted.fixture.componentInstance.cancel();
    const forB = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(forB.request.url).toContain(GUID_B);
    forB.flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne(`${READ}${GUID_B}`).flush(order({ orderId: GUID_B }));
  });

  it('drops a cancel FAILURE for the prior order the same way, banner included', async () => {
    const mounted = await mountWith(order());
    controller = mounted.controller;

    mounted.fixture.componentInstance.cancel();
    const forA = controller.expectOne((r) => r.url.endsWith('/cancel'));

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();
    controller.expectOne(`${READ}${GUID_B}`).flush(order({ orderId: GUID_B }));

    forA.flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    expect(mounted.fixture.componentInstance.error()).toBeNull();
  });

  it('drops a read reply for the prior order, so A is never drawn under B', async () => {
    const mounted = mount(GUID_A);
    controller = mounted.controller;
    const forA = controller.expectOne(`${READ}${GUID_A}`);

    mounted.paramMap.next(GUID_B);
    mounted.fixture.detectChanges();
    const forB = controller.expectOne(`${READ}${GUID_B}`);

    forA.flush(order());
    expect(mounted.fixture.componentInstance.order()).toBeNull();

    forB.flush(order({ orderId: GUID_B }));
    expect(mounted.fixture.componentInstance.order()?.orderId).toBe(GUID_B);
  });
});
