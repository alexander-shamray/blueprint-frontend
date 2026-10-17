import { HttpEventType, provideHttpClient } from '@angular/common/http';
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

  it('sends nothing for an id that is not one path segment, and answers 404', () => {
    // '..' would resolve to /bff/v1/ with the bearer attached; '' is the list.
    for (const id of ['', '.', '..']) {
      const failed = vi.fn();
      api.get(id).subscribe({ error: failed });

      expect(failed).toHaveBeenCalledOnce();
      expect(failed.mock.calls[0][0]).toMatchObject({ status: 404 });
    }
    controller.expectNone(() => true);
  });

  it('reads one order by id, encoded as a single path segment', () => {
    api.get('a/b?c').subscribe();

    const request = controller.expectOne('http://localhost:5000/bff/v1/orders/a%2Fb%3Fc');
    expect(request.request.method).toBe('GET');
    request.flush({});
  });

  describe('stream', () => {
    const URL = 'http://localhost:5000/bff/v1/orders/o1/events';
    const frame = (id: string, status: string): string =>
      `id: ${id}
event: order
data: ${JSON.stringify({ orderId: 'o1', status })}

`;

    it('asks for an event stream, with the id of the last event it holds', () => {
      api.stream('o1', 't0').subscribe();

      const request = controller.expectOne(URL);
      expect(request.request.headers.get('Accept')).toBe('text/event-stream');
      expect(request.request.headers.get('Last-Event-ID')).toBe('t0');
      expect(request.request.reportProgress).toBe(true);
      request.flush('');
    });

    it('sends no Last-Event-ID before there is an event to name', () => {
      api.stream('o1').subscribe();

      const request = controller.expectOne(URL);
      expect(request.request.headers.has('Last-Event-ID')).toBe(false);
      request.flush('');
    });

    it('emits each event as its frame completes, and none twice when the response ends', () => {
      const seen: string[] = [];
      const completed = vi.fn();
      api.stream('o1').subscribe({ next: (e) => seen.push(`${e.id}:${e.order.status}`), complete: completed });

      const request = controller.expectOne(URL);
      const first = frame('t1', 'placed');
      const second = frame('t2', 'confirmed');
      // The second frame arrives in two chunks.
      request.event({ type: HttpEventType.DownloadProgress, loaded: 0, partialText: first });
      request.event({ type: HttpEventType.DownloadProgress, loaded: 0, partialText: first + second.slice(0, 20) });
      expect(seen).toEqual(['t1:placed']);

      request.event({ type: HttpEventType.DownloadProgress, loaded: 0, partialText: first + second });
      expect(seen).toEqual(['t1:placed', 't2:confirmed']);
      expect(completed).not.toHaveBeenCalled();

      request.flush(first + second);
      expect(seen).toEqual(['t1:placed', 't2:confirmed']);
      expect(completed).toHaveBeenCalledOnce();
    });

    it('reads a response that arrives whole, with no progress event before it', () => {
      const seen = vi.fn();
      api.stream('o1').subscribe(seen);

      controller.expectOne(URL).flush(frame('t1', 'placed'));

      expect(seen).toHaveBeenCalledOnce();
    });

    it('gives a failure the problem details its body carried, as any other call does', () => {
      const failed = vi.fn();
      api.stream('o1').subscribe({ error: failed });

      controller
        .expectOne(URL)
        .flush(JSON.stringify({ title: 'Not Found', status: 404, detail: 'No order with that id.' }), {
          status: 404,
          statusText: 'Not Found',
        });

      expect(failed.mock.calls[0][0]).toMatchObject({
        status: 404,
        error: { detail: 'No order with that id.' },
      });
    });

    it('keeps a failure whose body is not JSON as it came', () => {
      const failed = vi.fn();
      api.stream('o1').subscribe({ error: failed });

      controller.expectOne(URL).flush('<html>', { status: 502, statusText: 'Bad Gateway' });

      expect(failed.mock.calls[0][0]).toMatchObject({ status: 502, error: '<html>' });
    });

    it('closes the connection when unsubscribed', () => {
      const subscription = api.stream('o1').subscribe();
      const request = controller.expectOne(URL);

      subscription.unsubscribe();

      expect(request.cancelled).toBe(true);
    });

    it('sends nothing for an id that is not one path segment, and answers 404', () => {
      for (const id of ['', '.', '..']) {
        const failed = vi.fn();
        api.stream(id).subscribe({ error: failed });

        expect(failed.mock.calls[0][0]).toMatchObject({ status: 404 });
      }
      controller.expectNone(() => true);
    });
  });
});
