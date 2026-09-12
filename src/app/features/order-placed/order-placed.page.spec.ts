import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { OrderPlacedPage } from './order-placed.page';

const GUID_A = '44444444-4444-4444-4444-444444444444';
const GUID_B = '55555555-5555-5555-5555-555555555555';

/**
 * Shared with the tests that assert the 401 row: a page-level mock of the one
 * method spec §6 asks the caller to invoke.
 */
let signIn: ReturnType<typeof vi.fn>;

function mount(id: string): { fixture: ComponentFixture<OrderPlacedPage>; paramMap: BehaviorSubject<string> } {
  TestBed.resetTestingModule();

  // A BehaviorSubject-backed paramMap, not just `snapshot`, so the reuse
  // test below can drive a second id through the SAME ActivatedRoute the
  // way Angular's `advanceActivatedRoute` does on a reused route — the path
  // that exists whenever a route's `RouteReuseStrategy` reuses a component
  // across two different `:id`s, IonicRouteStrategy included.
  const paramMap = new BehaviorSubject(id);
  signIn = vi.fn(async () => undefined);

  TestBed.configureTestingModule({
    imports: [OrderPlacedPage],
    providers: [
      provideRouter([]),
      // The real interceptor. The 429 window is no longer driven by this
      // page's error signal — `rateLimitInterceptor` opens it from the
      // response — so a spec without it would be testing a page whose
      // rate-limit binding nothing can ever set. `authInterceptor` is not
      // here because nothing in that window depends on it any more: the
      // bucket is picked from the route, not from the bearer.
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

  const fixture = TestBed.createComponent(OrderPlacedPage);
  fixture.detectChanges();
  return { fixture, paramMap };
}

describe('OrderPlacedPage', () => {
  let controller: HttpTestingController;

  afterEach(() => controller?.verify());

  it('renders the order id and the no-read-endpoint sentence for a real order', () => {
    const { fixture } = mount(GUID_A);

    expect(fixture.nativeElement.textContent).toContain(GUID_A);
    expect(fixture.nativeElement.textContent).toContain(
      'The platform exposes no endpoint that reads an order back',
    );

    const button = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    expect(button).toBeTruthy();
  });

  it('sends customer_request and offers no other reason, via the rendered Cancel button', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    const button: HTMLElement = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    button.click();

    // The other four codes are the platform's own findings — the saga's stock
    // outcomes and Payments' results. A customer cannot truthfully assert any
    // of them, and the endpoint stamps origin User whatever arrives.
    const request = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    // The half of the name that the body assertion does not cover: no picker
    // is rendered at all. Asserting CANCEL_REASONS contains customer_request
    // would prove nothing here — that is a fact about a frozen constant, true
    // whatever this page puts on screen.
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();

    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('reports the 204 with the cancelled note, clearing a prior error', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).not.toBeNull();

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(true);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Cancelled. The platform answered 204.');
  });

  it('guards a second tap while a cancel is in flight — no commandId here to replay under', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    fixture.componentInstance.cancel();

    // Exactly one request outstanding: expectOne throws if a second one was
    // sent. Flushing it satisfies afterEach's verify().
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
  });

  it('maps a 403 to a banner naming orders:cancel', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toMatchObject({
      kind: 'forbidden',
      permission: 'orders:cancel',
    });
  });

  it('invokes sign-in on a 401 and replays the cancellation for the same order', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    // Spec §6's 401 row, on the one page with no commandId to replay under.
    // What makes the replay safe here is the status code itself: a 401 is
    // refused at the edge, before the handler, so no cancellation was
    // recorded and this is the first one rather than a second.
    expect(signIn).toHaveBeenCalledOnce();

    const replay = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(replay.request.url).toContain(GUID_A);
    expect(replay.request.body).toEqual({ reason: 'customer_request' });

    replay.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(true);
  });

  it('does not replay a cancellation onto a different order the route handed this instance', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });

    // The sign-in resolves a tick later — and in between, this cached
    // component is reused for another order. Replaying "cancel" now would
    // cancel an order the customer never asked to cancel, which is worse than
    // the banner it replaced.
    paramMap.next(GUID_B);
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
    controller.expectNone((r) => r.url.endsWith('/cancel'));
  });

  it('disables Cancel order while a 429 window is open', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller.expectOne((r) => r.url.endsWith('/cancel')).flush(
      { title: 'Too many requests', status: 429 },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);

    const cancel = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    expect(cancel.disabled).toBe(true);
  });

  it('hides cancel and explains when the command already committed', () => {
    const { fixture } = mount('already-committed');

    expect(fixture.componentInstance.canCancel()).toBe(false);
    expect(fixture.componentInstance.alreadyCommitted()).toBe(true);

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Already committed');
    expect(text).toContain('already been applied');
    // No order id came back, so there is nothing to cancel and nothing to
    // read — neither the sentinel nor a real id belongs on screen here.
    expect(text).not.toContain('already-committed');
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-button')].some(
        (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
      ),
    ).toBe(false);
  });

  it('drops a cancel reply for the prior order when the route hands this instance a new :id', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    // A cancel is issued for order A and is still outstanding...
    fixture.componentInstance.cancel();
    const forA = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(forA.request.url).toContain(GUID_A);

    // ...when the route reuses this SAME instance for order B. The reuse test
    // below swaps the id only after A's response has landed, so it never
    // reaches this window; this one lives entirely inside it.
    paramMap.next(GUID_B);
    await fixture.whenStable();
    fixture.detectChanges();

    // A's 204 lands late. Applied, it would put "Cancelled. The platform
    // answered 204." under order B — a cancellation nobody sent for B, and one
    // the user cannot tell from a real one.
    forA.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Cancelled. The platform answered 204.');

    // And B's Cancel button is live rather than silently inert: the in-flight
    // guard was released when the id changed, not when A's reply arrived.
    fixture.componentInstance.cancel();
    const forB = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(forB.request.url).toContain(GUID_B);

    forB.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(true);
  });

  it('drops a cancel FAILURE for the prior order the same way, banner included', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    const forA = controller.expectOne((r) => r.url.endsWith('/cancel'));

    paramMap.next(GUID_B);
    await fixture.whenStable();

    // Both branches of the subscribe check the id, not just the success one:
    // a 403 about order A under order B's heading is the same false statement
    // as a 204 about it, and it is the branch that names a permission.
    forA.flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBeNull();
  });

  it('drives a new :id through the route and updates what a reused instance shows', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    // Cancel order A on this instance...
    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    expect(fixture.componentInstance.cancelled()).toBe(true);

    // ...then simulate Angular's default RouteReuseStrategy reusing this
    // SAME component across placed/A -> placed/B: advanceActivatedRoute
    // swaps `snapshot` in place and emits the new ParamMap on `paramMap`
    // without a new component ever being constructed. IonicRouteStrategy
    // (now installed in app.config.ts) prevents this reuse app-wide, but the
    // page must be correct even if it were not.
    paramMap.next(GUID_B);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.orderId()).toBe(GUID_B);
    expect(fixture.nativeElement.textContent).toContain(GUID_B);
    expect(fixture.nativeElement.textContent).not.toContain(GUID_A);

    // Order A's "cancelled" note must not bleed onto order B, which this
    // instance has never touched.
    expect(fixture.componentInstance.cancelled()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Cancelled. The platform answered 204.');
  });
});
