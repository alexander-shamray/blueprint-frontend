import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { CheckoutPage } from './checkout.page';

const validAddress = {
  line1: '1 Example Street', line2: '', city: 'Doha', postalCode: '00000', country: 'QA',
};

describe('CheckoutPage', () => {
  let fixture: ComponentFixture<CheckoutPage>;
  let controller: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;
  let signIn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    signIn = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      imports: [CheckoutPage],
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
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
        {
          provide: AuthService,
          useValue: { signIn, user: () => signal({ username: 'demo' }), accessToken: () => 't' },
        },
      ],
    });

    TestBed.inject(CartStore).add({
      productId: 'p1', name: 'Widget', thumbnailUrl: null,
      amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
    });
    // Quote currency deliberately differs from the cart line's listed
    // currency (EUR) — a quote repricing a basket into another currency is
    // the ordinary case, and the whole point of carrying currency from the
    // quote rather than the cart (or a picker) can only be proven by a test
    // where the two disagree. A same-currency fixture would pass just as
    // well with a hard-coded 'EUR' or a `?? 'EUR'` fallback.
    TestBed.inject(CheckoutHandoff).set({
      currency: 'GBP',
      lines: [{ productId: 'p1', name: 'Widget', amount: 10, quantity: 1, lineTotal: 10 }],
      total: 10, unpriced: [],
    });

    navigate = vi.fn(async () => true);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate as never);

    fixture = TestBed.createComponent(CheckoutPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.form.setValue(validAddress);
  });

  afterEach(() => controller.verify());

  it('carries the currency from the quote, not from a picker', () => {
    expect(fixture.componentInstance.currency()).toBe('GBP');
  });

  it('sends the cart as items and the address as five fields with line2 null when blank', () => {
    fixture.componentInstance.placeOrder();

    const body = controller.expectOne('http://localhost:5000/api/v1/orders').request.body;

    expect(body.items).toEqual([{ productId: 'p1', quantity: 1 }]);
    expect(body.shippingAddress).toEqual({
      line1: '1 Example Street', line2: null, city: 'Doha', postalCode: '00000', country: 'QA',
    });
    expect(body.currency).toBe('GBP');
  });

  it('reuses the same commandId when a 5xx is retried, so the retry is a replay', async () => {
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    fixture.componentInstance.placeOrder();
    const second = controller.expectOne('http://localhost:5000/api/v1/orders');

    expect(second.request.body.commandId).toBe(firstId);
    second.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    // Not left dangling: that flush runs the whole success handler and
    // schedules change detection plus CartStore's persistence effect. A test
    // that ends on an unawaited flush leaves that work to whichever test
    // runs next.
    await fixture.whenStable();
  });

  it('mints a new commandId after the form is edited following a validation failure', async () => {
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    first.flush(
      { status: 400, errors: { 'ShippingAddress.PostalCode': ['Not a postal code.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    fixture.componentInstance.form.controls.postalCode.setValue('12345');
    fixture.componentInstance.placeOrder();

    const second = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(second.request.body.commandId).not.toBe(firstId);
    second.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('treats command.already_committed as success pending confirmation and moves on', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 409, code: 'command.already_committed', detail: 'Already applied.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    // No order id came back, so the placed page is reached with the sentinel
    // and says the id was already committed.
    expect(navigate).toHaveBeenCalledWith(['/tabs/cart/placed', 'already-committed']);
    // The other half of "treated as success": the basket is spent exactly as
    // it would be on a real 200, and the id can never be resubmitted.
    expect(TestBed.inject(CartStore).isEmpty()).toBe(true);
    expect(fixture.componentInstance.identity.isSpent()).toBe(true);
  });

  it('does not navigate on request.in_progress — the first attempt is still running', async () => {
    fixture.componentInstance.placeOrder();
    const request = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = request.request.body.commandId;

    request.flush(
      { status: 409, code: 'request.in_progress', detail: 'Already in progress. Retry.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()?.kind).toBe('inProgress');
    // The pair that makes reading `code` rather than status meaningful:
    // unlike already_committed, this 409 leaves the basket and the id alone
    // — the first attempt is still running, nothing has been decided yet.
    expect(TestBed.inject(CartStore).isEmpty()).toBe(false);
    expect(fixture.componentInstance.identity.current()).toBe(firstId);
  });

  it('clears the cart and navigates to the order on success', async () => {
    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(TestBed.inject(CartStore).isEmpty()).toBe(true);
    // The checkout half of the guard's contract: quoteGuard reads this
    // signal to decide whether the route is reachable at all, so it must be
    // null here or a user could navigate back into checkout with an emptied
    // cart and be waved straight through.
    expect(TestBed.inject(CheckoutHandoff).quote()).toBeNull();
    expect(navigate).toHaveBeenCalledWith([
      '/tabs/cart/placed', '44444444-4444-4444-4444-444444444444',
    ]);
  });

  it('does not throw or send a second request if placeOrder() runs again after a success', async () => {
    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    // The handoff is now null (asserted above, in the previous test). A
    // click landing in the window before router.navigate() resolves — the
    // form is still valid, and onSuccess() already cleared identity.isSpent()
    // — must not reach currency()'s assertion with a null quote underneath.
    expect(() => fixture.componentInstance.placeOrder()).not.toThrow();
    controller.expectNone('http://localhost:5000/api/v1/orders');
  });

  it('replays only after sign-in has actually completed, not merely been started', async () => {
    // The guard for issue #3. The stub above resolves immediately with no
    // token change, which models neither real strategy: WebAuthStrategy
    // navigates away and never comes back, and NativeAuthStrategy used to
    // resolve the moment the system browser opened — so this page replayed
    // the order while still holding the token the edge had just refused.
    //
    // Here signIn resolves only once a token is in place, and the assertion
    // is on the ORDER of those two events: the replay must not be in flight
    // before the sign-in it is waiting on has finished.
    let signedIn = false;
    signIn.mockImplementation(async () => {
      // The replay must not have gone out yet at this point.
      controller.expectNone('http://localhost:5000/api/v1/orders');
      signedIn = true;
    });

    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;

    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signedIn).toBe(true);
    const replay = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(replay.request.body.commandId).toBe(firstId);

    replay.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('does not replay when sign-in fails or is dismissed', async () => {
    // NativeAuthStrategy rejects when the user backs out of the system
    // browser or the code cannot be exchanged (#3). Replaying then would put
    // the order on the wire with the same refused token; the banner is the
    // honest outcome.
    signIn.mockRejectedValue(new Error('Sign-in was dismissed before it completed.'));

    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    controller.expectNone('http://localhost:5000/api/v1/orders');
    expect(fixture.componentInstance.error()).not.toBeNull();
  });

  it('invokes sign-in on a 401 and replays the order under the same commandId', async () => {
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;

    // An access token that expired mid-checkout: five minutes is the whole
    // lifetime (spec §2.1), so this is the ordinary case rather than the
    // exotic one.
    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();

    // "…and replays after" (spec §6). The replay carries the SAME commandId,
    // which is the only thing that makes an automatic resubmission of an order
    // defensible: IdempotencyBehavior keys on it, so the platform sees a
    // replay rather than a second order.
    const replay = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(replay.request.body.commandId).toBe(firstId);

    replay.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('does not loop when the replay is refused with another 401', async () => {
    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    // The replay is refused too — an account that lost the permission, a realm
    // mid-restart. Sign-in is offered again, because a 401 always means the
    // caller must authenticate, but the automatic replay is spent: one more
    // request and no third one.
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledTimes(2);
    controller.expectNone('http://localhost:5000/api/v1/orders');
  });

  it('disables Place order while a 429 window is open', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { title: 'Too many requests', status: 429 },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);

    const place = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Place order',
    );
    expect(place.disabled).toBe(true);
  });

  it('surfaces field errors keyed as the backend keyed them', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 400, errors: { 'ShippingAddress.City': ['City is required.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.fields).toEqual({
      'ShippingAddress.City': ['City is required.'],
    });
  });
});
