import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { CartPage } from './cart.page';

const product = (id: string) => ({
  productId: id, name: `Product ${id}`, thumbnailUrl: null,
  amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
});

/**
 * A priced line as the BFF sends one. `lineTotal` is passed in rather than
 * derived from `amount * quantity` on purpose: these fixtures are the
 * platform's word, and a fixture that did the multiplication itself could not
 * tell a client rendering `lineTotal` from a client recomputing it.
 */
const quoted = (id: string, amount: number, quantity: number, lineTotal: number) => ({
  productId: id, name: `Product ${id}`, amount, quantity, lineTotal,
});

describe('CartPage', () => {
  let fixture: ComponentFixture<CartPage>;
  let controller: HttpTestingController;
  let store: CartStore;
  const signIn = vi.fn(async () => undefined);

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [CartPage],
      providers: [
        // A stub for /tabs/cart/checkout, which checkout() navigates to —
        // only so the navigation resolves instead of rejecting with
        // NG04002 (no route matches); nothing here renders it.
        provideRouter([{ path: 'tabs/cart/checkout', children: [] }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
        { provide: AuthService, useValue: { signIn, user: () => signal({ username: 'demo' }), accessToken: () => 't' } },
      ],
    });

    store = TestBed.inject(CartStore);
    store.add(product('p1'));
    store.add(product('p2'));

    fixture = TestBed.createComponent(CartPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => controller.verify());

  it('POSTs the lines the cart holds, quantities included, in the selected currency', () => {
    // Three of p1 and one of p2: a basket the old contract could not express
    // at all, and the one thing a quote has to be asked about now.
    fixture.componentInstance.setQuantity('p1', 3);
    fixture.componentInstance.setCurrency('GBP');
    fixture.componentInstance.getQuote();

    const request = controller.expectOne((r) => r.url.includes('/bff/v1/checkout/quote'));

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      currency: 'GBP',
      lines: [
        { productId: 'p1', quantity: 3 },
        { productId: 'p2', quantity: 1 },
      ],
    });

    request.flush({ currency: 'GBP', lines: [], total: 0, unpriced: [] });
  });

  it('sends only the members the request has, not the listing price the cart holds', () => {
    // A CartLine also carries `name`, `amount` and the currency it was listed
    // in. The pricing endpoint has no business being told what this client
    // thought a product cost, and QuoteRequestLine has two members.
    fixture.componentInstance.getQuote();

    const request = controller.expectOne((r) => r.url.includes('/quote'));

    for (const line of request.request.body.lines) {
      expect(Object.keys(line).sort()).toEqual(['productId', 'quantity']);
    }

    request.flush({ currency: 'EUR', lines: [], total: 0, unpriced: [] });
  });

  it('renders the basket total the BFF sent, never a client-side sum', async () => {
    fixture.componentInstance.setQuantity('p1', 2);
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [quoted('p1', 4, 2, 8), quoted('p2', 4, 1, 4)],
      // Deliberately neither the sum of the amounts (8) nor the sum of the
      // line totals (12). Whatever the platform says the basket costs is the
      // number on screen; a client that recomputed would show one of those.
      total: 99,
      unpriced: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.quote()?.total).toBe(99);
    // On screen, and labelled Total — asserting the signal alone would pass
    // with the template deleted, which is how the last relabelling was found.
    expect(fixture.nativeElement.textContent).toContain('Total: 99 EUR');
  });

  it('renders each line total as the BFF computed it, rather than multiplying', async () => {
    fixture.componentInstance.setQuantity('p1', 2);
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      // 2 × 12.50 would be 25. The fixture says 7, so a client doing its own
      // arithmetic renders 25 and fails here.
      lines: [quoted('p1', 12.5, 2, 7), quoted('p2', 4, 1, 4)],
      total: 11,
      unpriced: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent.replace(/\s+/g, ' ');

    expect(text).toContain('2 × 12.5 EUR = 7 EUR');
    expect(text).not.toContain('= 25 EUR');
  });

  it('shows a quoted line whose price is zero', async () => {
    // PublishProductValidator.cs allows GreaterThanOrEqualTo(0), so a free
    // product is legal — and a truthiness test on the price would hide it as
    // though it had never been quoted.
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [quoted('p1', 0, 1, 0), quoted('p2', 4, 1, 4)],
      total: 4,
      unpriced: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.quotedLines()['p1']).toBeDefined();
    expect(fixture.nativeElement.textContent.replace(/\s+/g, ' ')).toContain('1 × 0 EUR = 0 EUR');
  });

  it('marks unpriced lines rather than hiding them, and blocks checkout', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [quoted('p1', 4, 1, 4)],
      total: 4,
      unpriced: ['p2'],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.isUnpriced('p2')).toBe(true);
    expect(fixture.componentInstance.lines()).toHaveLength(2);
    expect(fixture.componentInstance.canCheckout()).toBe(false);
  });

  it('enables checkout when a quote exists with no unpriced lines', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [quoted('p1', 4, 1, 4), quoted('p2', 4, 1, 4)],
      total: 8,
      unpriced: [],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.canCheckout()).toBe(true);
  });

  it('prompts for sign-in on a 401 instead of showing a raw error', async () => {
    fixture.componentInstance.getQuote();
    controller
      .expectOne((r) => r.url.includes('/quote'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
  });

  it('discards a stale quote when a quantity changes', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR', lines: [], total: 8, unpriced: [],
    });
    await fixture.whenStable();

    fixture.componentInstance.setQuantity('p1', 5);

    // A quote priced two of something is not a quote for five of it.
    expect(fixture.componentInstance.quote()).toBeNull();
    expect(fixture.componentInstance.canCheckout()).toBe(false);
  });

  it('drops a getQuote() response that lands after a quantity change already invalidated it', async () => {
    fixture.componentInstance.getQuote();
    const request = controller.expectOne((r) => r.url.includes('/quote'));

    // The request above is still in flight when the basket changes underneath
    // it — invalidateQuote() bumps the generation before this stale response
    // is flushed.
    fixture.componentInstance.setQuantity('p1', 5);

    request.flush({ currency: 'EUR', lines: [], total: 8, unpriced: [] });
    await fixture.whenStable();

    // The response answers a question ("what does the old basket cost?")
    // that no longer applies, and must not silently re-enable checkout.
    expect(fixture.componentInstance.quote()).toBeNull();
    expect(fixture.componentInstance.canCheckout()).toBe(false);
  });

  it('clears the checkout handoff when a quantity changes after checkout()', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [quoted('p1', 4, 1, 4), quoted('p2', 4, 1, 4)],
      total: 8,
      unpriced: [],
    });
    await fixture.whenStable();

    fixture.componentInstance.checkout();
    const handoff = TestBed.inject(CheckoutHandoff);
    expect(handoff.quote()).not.toBeNull();

    // A quantity change after handing the quote to checkout must retract it —
    // the guard reads the handoff, not this page, and must not be left
    // trusting a quote for a basket that no longer exists.
    fixture.componentInstance.setQuantity('p1', 5);
    expect(handoff.quote()).toBeNull();
  });
});
