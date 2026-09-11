import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [CheckoutPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });

    TestBed.inject(CartStore).add({
      productId: 'p1', name: 'Widget', thumbnailUrl: null,
      amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
    });
    TestBed.inject(CheckoutHandoff).quote.set({
      currency: 'EUR', lines: [{ productId: 'p1', name: 'Widget', amount: 10 }], total: 10, unpriced: [],
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
    expect(fixture.componentInstance.currency()).toBe('EUR');
  });

  it('sends the cart as items and the address as five fields with line2 null when blank', () => {
    fixture.componentInstance.placeOrder();

    const body = controller.expectOne('http://localhost:5000/api/v1/orders').request.body;

    expect(body.items).toEqual([{ productId: 'p1', quantity: 1 }]);
    expect(body.shippingAddress).toEqual({
      line1: '1 Example Street', line2: null, city: 'Doha', postalCode: '00000', country: 'QA',
    });
    expect(body.currency).toBe('EUR');
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
  });

  it('does not navigate on request.in_progress — the first attempt is still running', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 409, code: 'request.in_progress', detail: 'Already in progress. Retry.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()?.kind).toBe('inProgress');
  });

  it('clears the cart and navigates to the order on success', async () => {
    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(TestBed.inject(CartStore).isEmpty()).toBe(true);
    expect(navigate).toHaveBeenCalledWith([
      '/tabs/cart/placed', '44444444-4444-4444-4444-444444444444',
    ]);
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
