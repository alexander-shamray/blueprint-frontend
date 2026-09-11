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

  it('quotes with one productId per distinct product and the selected currency', () => {
    fixture.componentInstance.setCurrency('GBP');
    fixture.componentInstance.getQuote();

    const request = controller.expectOne((r) => r.url.includes('/bff/v1/checkout/quote'));
    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2']);
    expect(request.request.params.get('currency')).toBe('GBP');

    request.flush({ currency: 'GBP', lines: [], total: 0, unpriced: [] });
  });

  it('shows the reply total, never a client-side sum', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [
        { productId: 'p1', name: 'Product p1', amount: 4 },
        { productId: 'p2', name: 'Product p2', amount: 4 },
      ],
      // Deliberately not 8. The BFF's number is the one shown.
      total: 99,
      unpriced: [],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.quote()?.total).toBe(99);
  });

  it('marks unpriced lines rather than hiding them, and blocks checkout', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [{ productId: 'p1', name: 'Product p1', amount: 4 }],
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
      lines: [
        { productId: 'p1', name: 'Product p1', amount: 4 },
        { productId: 'p2', name: 'Product p2', amount: 4 },
      ],
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
      lines: [
        { productId: 'p1', name: 'Product p1', amount: 4 },
        { productId: 'p2', name: 'Product p2', amount: 4 },
      ],
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
