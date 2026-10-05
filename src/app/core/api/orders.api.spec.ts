import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrdersApi } from './orders.api';

describe('OrdersApi', () => {
  let api: OrdersApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OrdersApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrdersApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('lists through the /bff namespace, never /api, and sends no cursor on the first page', () => {
    const seen = vi.fn();
    api.list(null).subscribe(seen);

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/bff/v1/orders',
    );
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.has('cursor')).toBe(false);

    request.flush({ items: [], nextCursor: null });
    expect(seen).toHaveBeenCalledWith({ items: [], nextCursor: null });
  });

  it('carries the cursor the previous page returned', () => {
    api.list('abc').subscribe();

    const request = controller.expectOne((r) => r.url === 'http://localhost:5000/bff/v1/orders');
    expect(request.request.params.get('cursor')).toBe('abc');
    request.flush({ items: [], nextCursor: null });
  });

  it('sends no customer id: the subject is the principal, never the request', () => {
    api.list(null).subscribe();

    const request = controller.expectOne((r) => r.url === 'http://localhost:5000/bff/v1/orders');
    expect(request.request.params.keys().sort()).toEqual(['limit']);
    request.flush({ items: [], nextCursor: null });
  });

  it('reads one order by id, encoded as a single path segment', () => {
    api.get('a/b?c').subscribe();

    const request = controller.expectOne('http://localhost:5000/bff/v1/orders/a%2Fb%3Fc');
    expect(request.request.method).toBe('GET');
    request.flush({});
  });
});
