import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutApi } from './checkout.api';

describe('CheckoutApi', () => {
  let api: CheckoutApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CheckoutApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CheckoutApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('repeats productId once per product and sends one currency', () => {
    api.quote(['p1', 'p2', 'p3'], 'EUR').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/bff/v1/checkout/quote',
    );

    // Guid[] binds from repeated parameters, not from a comma-joined list:
    // "p1,p2" would bind as one malformed Guid and answer 400.
    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2', 'p3']);
    expect(request.request.params.get('currency')).toBe('EUR');

    request.flush({ currency: 'EUR', lines: [], total: 0, unpriced: [] });
  });

  it('sends each distinct product once', () => {
    // The BFF deduplicates anyway, but spending the request on the same id
    // twice spends the caller's rate-limit budget on nothing.
    api.quote(['p1', 'p1', 'p2'], 'EUR').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/bff/v1/checkout/quote',
    );

    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2']);
    request.flush({ currency: 'EUR', lines: [], total: 0, unpriced: [] });
  });

  it('uses the /bff namespace, not /api', () => {
    api.quote(['p1'], 'GBP').subscribe();

    const request = controller.expectOne((r) => r.url.includes('/bff/'));
    expect(request.request.url).toBe('http://localhost:5000/bff/v1/checkout/quote');
    request.flush({ currency: 'GBP', lines: [], total: 0, unpriced: [] });
  });
});
