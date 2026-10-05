import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { WritableSignal, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
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
  /** Writable, so a test can hand the session to somebody else mid-sign-in. */
  let user: WritableSignal<CurrentUser | null>;

  beforeEach(async () => {
    signIn = vi.fn(async () => undefined);
    user = signal<CurrentUser | null>({
      username: 'demo', subject: 'subject-demo', permissions: ['orders:write'], expiresAt: 0,
    });
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
          useValue: { signIn, user: () => user, accessToken: () => 't' },
        },
      ],
    });

    TestBed.inject(CartStore).add({
      productId: 'p1', name: 'Widget', thumbnailUrl: null,
      amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z', quantityAvailable: null,
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

  it('on command.id_reused stays put with the edited address, and spends the basket and the id', async () => {
    // The route the platform answers this on: a failure after which the id is
    // held, an edit, and a resubmission — when the first attempt had in fact
    // committed.
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    fixture.componentInstance.form.controls.postalCode.setValue('12345');
    fixture.componentInstance.placeOrder();
    const second = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(second.request.body.commandId).toBe(firstId);
    second.flush(
      { status: 409, code: 'command.id_reused', detail: 'Already used for a different request.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    fixture.detectChanges();

    // Not the placed page: that page would say the order just sent — the
    // edited one — was placed, and the order placed is the earlier one.
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()?.kind).toBe('idReused');
    expect(fixture.componentInstance.form.controls.postalCode.value).toBe('12345');
    expect(fixture.nativeElement.textContent).toContain(
      'any changes you made since were not applied',
    );

    // The earlier order exists, so its basket is spent as on a 200, and this
    // form cannot send again: under the old id it meets the same refusal, and
    // under a new one it would be a second order.
    expect(TestBed.inject(CartStore).isEmpty()).toBe(true);
    expect(TestBed.inject(CheckoutHandoff).quote()).toBeNull();
    expect(fixture.componentInstance.identity.isSpent()).toBe(true);

    const place = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Place order',
    );
    expect(place.disabled).toBe(true);

    fixture.componentInstance.placeOrder();
    controller.expectNone('http://localhost:5000/api/v1/orders');
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

  it('does not replay when somebody else completes the sign-in', async () => {
    // A native sign-in finished by another account — a shared device, or a
    // system browser whose Keycloak session is somebody else's. Under that
    // subject the same commandId is a new command, so a replay would place
    // this basket as an order on their account that they never pressed for.
    signIn.mockImplementation(async () => {
      user.set({ username: 'other', subject: 'subject-other', permissions: [], expiresAt: 0 });
    });

    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
    controller.expectNone('http://localhost:5000/api/v1/orders');
    // And the refused buyer's banner and address are not left for them either.
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.form.controls.line1.value).toBe('');
  });

  it('starts the form again for a different subject: address, banner and id', async () => {
    const page = fixture.componentInstance;
    page.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    // A 5xx, after which the id is held: an edit alone would not mint a new
    // one, so a new id below can only be the subject change's.
    first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();
    expect(page.error()).not.toBeNull();

    // A native sign-out and somebody else's sign-in, with this page still on
    // the Cart tab's stack.
    user.set({ username: 'other', subject: 'subject-other', permissions: [], expiresAt: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(page.form.getRawValue()).toEqual({
      line1: '', line2: '', city: '', postalCode: '', country: '',
    });
    expect(page.error()).toBeNull();
    expect(page.identity.current()).not.toBe(firstId);

    const place = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Place order',
    );
    expect(place.disabled).toBe(true);
  });

  it("drops the previous subject's field messages", async () => {
    const page = fixture.componentInstance;
    page.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      {
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { 'ShippingAddress.City': ['City is required.'] },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();
    expect(page.fieldErrors().city).toEqual(['City is required.']);

    user.set({ username: 'other', subject: 'subject-other', permissions: [], expiresAt: 0 });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.fieldErrors()).toEqual({});
  });

  it('keeps the form and the held id when the same buyer signs out and back in', async () => {
    const page = fixture.componentInstance;
    page.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    // A 5xx: the order may have been placed, so the id is held and the retry
    // has to carry it.
    first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    user.set(null);
    fixture.detectChanges();
    await fixture.whenStable();
    user.set({ username: 'demo', subject: 'subject-demo', permissions: [], expiresAt: 1 });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.form.getRawValue()).toEqual(validAddress);
    page.placeOrder();
    const retry = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(retry.request.body.commandId).toBe(firstId);
    retry.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('starts the form again when a different buyer signs in after a sign-out', async () => {
    const page = fixture.componentInstance;
    const firstId = page.identity.current();

    user.set(null);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.getRawValue()).toEqual(validAddress);

    user.set({ username: 'other', subject: 'subject-other', permissions: [], expiresAt: 0 });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(page.form.controls.line1.value).toBe('');
    expect(page.identity.current()).not.toBe(firstId);
  });

  it('drops a reply that lands once its buyer has signed out, and keeps their id', async () => {
    const page = fixture.componentInstance;
    page.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;

    user.set(null);
    fixture.detectChanges();
    await fixture.whenStable();
    first.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    // Nobody is taken to the order, the basket is not spent, and the busy
    // state still ends.
    expect(navigate).not.toHaveBeenCalled();
    expect(TestBed.inject(CartStore).isEmpty()).toBe(false);
    expect(page.submitting()).toBe(false);

    user.set({ username: 'demo', subject: 'subject-demo', permissions: [], expiresAt: 1 });
    fixture.detectChanges();
    await fixture.whenStable();
    page.placeOrder();
    const retry = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(retry.request.body.commandId).toBe(firstId);
    retry.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it("does not take another buyer's sign-in for a late 401's refused subject", async () => {
    const page = fixture.componentInstance;
    page.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');

    user.set({ username: 'other', subject: 'subject-other', permissions: [], expiresAt: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).not.toHaveBeenCalled();
    expect(page.error()).toBeNull();
    expect(page.submitting()).toBe(false);
    controller.expectNone('http://localhost:5000/api/v1/orders');
  });

  it('keeps the form while the same subject stays signed in', async () => {
    user.set({ username: 'demo', subject: 'subject-demo', permissions: [], expiresAt: 1 });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.form.getRawValue()).toEqual(validAddress);
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

  describe('per-field messages, the summary and the busy state', () => {
    const refuse = async (errors: Record<string, string[]>) => {
      fixture.componentInstance.placeOrder();
      controller.expectOne('http://localhost:5000/api/v1/orders').flush(
        { title: 'One or more validation errors occurred.', status: 400, errors },
        { status: 400, statusText: 'Bad Request' },
      );
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const notes = (field: string): string[] =>
      [...fixture.nativeElement.querySelectorAll(`.field-error[data-field="${field}"]`)].map(
        (el: HTMLElement) => el.textContent?.trim() ?? '',
      );

    it('puts each address message under its control and keeps the rest in the banner', async () => {
      await refuse({
        'ShippingAddress.City': ['City is required.'],
        'ShippingAddress.Country': ["'Country' is not in the correct format."],
        Items: ['An order cannot contain more than 100 items.'],
      });

      expect(notes('city')).toEqual(['City is required.']);
      expect(notes('country')).toEqual(["'Country' is not in the correct format."]);
      expect(fixture.componentInstance.bannerError()?.fields).toEqual({
        Items: ['An order cannot contain more than 100 items.'],
      });
    });

    it('keeps the banner title when every message landed on a control', async () => {
      await refuse({ 'ShippingAddress.City': ['City is required.'] });

      const banner = fixture.componentInstance.bannerError();
      expect(banner?.title).toBe('One or more validation errors occurred.');
      expect(banner?.fields).toBeUndefined();
    });

    it('drops a field message when that field is edited, and only that one', async () => {
      await refuse({
        'ShippingAddress.City': ['City is required.'],
        'ShippingAddress.PostalCode': ['Too long.'],
      });

      fixture.componentInstance.form.controls.city.setValue('Lusail');
      fixture.detectChanges();

      expect(notes('city')).toEqual([]);
      expect(notes('postalCode')).toEqual(['Too long.']);
    });

    it('is busy from the tap to the answer, says so on the button, and leaves it live', async () => {
      fixture.componentInstance.placeOrder();
      fixture.detectChanges();

      expect(fixture.componentInstance.submitting()).toBe(true);
      const button = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
        (el: HTMLElement) => el.getAttribute('type') === 'submit',
      );
      expect(button.textContent).toContain('Placing order');
      // The busy state is not a guard: a double-click while the request is
      // out still reaches the platform, which answers it with
      // request.in_progress (client-architecture.md §4).
      expect(button.disabled).toBe(false);

      controller.expectOne('http://localhost:5000/api/v1/orders').flush(
        { title: 'Server error', status: 500 },
        { status: 500, statusText: 'Error' },
      );
      await fixture.whenStable();

      expect(fixture.componentInstance.submitting()).toBe(false);
    });

    it('stays busy until the last of two double-clicked requests is answered', async () => {
      fixture.componentInstance.placeOrder();
      fixture.componentInstance.placeOrder();
      const [first, second] = controller.match('http://localhost:5000/api/v1/orders');
      expect(second).toBeDefined();

      first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
      await fixture.whenStable();
      expect(fixture.componentInstance.submitting()).toBe(true);

      second.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
      await fixture.whenStable();
      expect(fixture.componentInstance.submitting()).toBe(false);
    });

    it('summarises the quote it will order against, as the BFF priced it', () => {
      // Three figures that differ, none the product or sum of the others: the
      // beforeEach quote's 10 / 10 / 10 would let a deleted Total row, or one
      // the client added up, pass unseen.
      TestBed.inject(CheckoutHandoff).set({
        currency: 'GBP',
        lines: [{ productId: 'p1', name: 'Widget', amount: 10, quantity: 2, lineTotal: 7 }],
        total: 99, unpriced: [],
      });
      fixture.detectChanges();
      const list: HTMLElement =
        fixture.nativeElement.querySelector('[data-testid="order-summary"]');
      const summary: string = (list?.textContent ?? '').replace(/\s+/g, ' ');

      expect(summary).toContain('Widget');
      expect(summary).toContain('2 × £10.00 = £7.00');
      expect(summary).not.toContain('£20.00');

      const rows = [...list.querySelectorAll('ion-item')].map((item) =>
        (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
      );
      expect(rows.find((row) => row.startsWith('Total'))?.replace(/\s/g, '')).toBe('Total£99.00');
    });

    it('chooses the country from a select of codes, sending the code', () => {
      const select: HTMLSelectElement = fixture.nativeElement.querySelector('#checkout-country');
      const qatar = [...select.options].find((o) => o.value === 'QA');

      expect(qatar?.textContent?.trim()).toBe('Qatar');
      expect(select.value).toBe('QA');

      // View to model: the beforeEach value only proves the other direction.
      select.value = 'GB';
      select.dispatchEvent(new Event('change'));

      expect(fixture.componentInstance.form.controls.country.value).toBe('GB');
    });
  });
});
