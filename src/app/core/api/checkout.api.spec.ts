import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutApi } from './checkout.api';

const URL = 'http://localhost:5000/bff/v1/checkout/quote';

/** An empty priced reply — enough to let a request complete. */
const EMPTY = (currency: string) => ({ currency, lines: [], total: 0, unpriced: [] });

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

  it('POSTs a body of quantified lines, not a query string', () => {
    api
      .quote(
        [
          { productId: 'p1', quantity: 2 },
          { productId: 'p2', quantity: 1 },
        ],
        'EUR',
      )
      .subscribe();

    const request = controller.expectOne((r) => r.url === URL);

    // The verb is the contract (ADR-045): the old GET answers 405 now, and a
    // 405 is indistinguishable on this side from the platform being down.
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      currency: 'EUR',
      lines: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ],
    });
    // Nothing in the query string: a `quantity` array beside a `productId`
    // array is exactly the parallel-arrays binding QuoteRequest.cs refuses.
    expect(request.request.params.keys()).toEqual([]);

    request.flush(EMPTY('EUR'));
  });

  it('sends every line, including a repeated product', () => {
    // The BFF merges a repeated product, as Order.AddLine does one service
    // over, and the reply echoes the summed Quantity so the merge is visible.
    // Deduplicating here — which the old GET did, correctly, because an id
    // carried no information — would now discard part of the basket.
    api
      .quote(
        [
          { productId: 'p1', quantity: 2 },
          { productId: 'p1', quantity: 3 },
        ],
        'EUR',
      )
      .subscribe();

    const request = controller.expectOne((r) => r.url === URL);

    expect(request.request.body.lines).toEqual([
      { productId: 'p1', quantity: 2 },
      { productId: 'p1', quantity: 3 },
    ]);

    request.flush(EMPTY('EUR'));
  });

  it('uses the /bff namespace, not /api', () => {
    api.quote([{ productId: 'p1', quantity: 1 }], 'GBP').subscribe();

    const request = controller.expectOne((r) => r.url.includes('/bff/'));
    expect(request.request.url).toBe(URL);
    expect(request.request.body.currency).toBe('GBP');
    request.flush(EMPTY('GBP'));
  });
});
