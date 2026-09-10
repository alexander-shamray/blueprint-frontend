import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderingApi } from './ordering.api';
import { PlaceOrderCommand } from './types';

describe('OrderingApi', () => {
  let api: OrderingApi;
  let controller: HttpTestingController;

  const command: PlaceOrderCommand = {
    commandId: '11111111-1111-1111-1111-111111111111',
    items: [{ productId: 'p1', quantity: 2 }],
    shippingAddress: {
      line1: '1 Example Street',
      line2: null,
      city: 'Doha',
      postalCode: '00000',
      country: 'QA',
    },
    currency: 'EUR',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OrderingApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrderingApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('posts the command verbatim and returns the order id from a 200', () => {
    const seen = vi.fn();
    api.place(command).subscribe(seen);

    const request = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(command);

    request.flush('33333333-3333-3333-3333-333333333333', { status: 200, statusText: 'OK' });
    expect(seen).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
  });

  it('sends no customerId — the subject is bound from the principal', () => {
    api.place(command).subscribe();

    const request = controller.expectOne('http://localhost:5000/api/v1/orders');

    // Exactly four keys. A customerId here would be a field any authenticated
    // caller sets to somebody else's GUID; PlaceOrderCommand omits it on
    // purpose and the client must not offer one back.
    expect(Object.keys(request.request.body)).toEqual([
      'commandId', 'items', 'shippingAddress', 'currency',
    ]);

    request.flush('33333333-3333-3333-3333-333333333333', { status: 200, statusText: 'OK' });
  });

  it('cancels with the reason in the body and accepts a 204', () => {
    const done = vi.fn();
    api.cancel('33333333-3333-3333-3333-333333333333', 'customer_request').subscribe({ complete: done });

    const request = controller.expectOne(
      'http://localhost:5000/api/v1/orders/33333333-3333-3333-3333-333333333333/cancel',
    );

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toHaveBeenCalledOnce();
  });
});
