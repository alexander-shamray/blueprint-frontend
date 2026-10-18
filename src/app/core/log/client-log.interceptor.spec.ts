import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientLog, ClientLogEvent, ConsoleClientLog, pathOf } from './client-log';
import { clientLogInterceptor } from './client-log.interceptor';

const GATEWAY = 'http://localhost:5000';

describe('clientLogInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let events: ClientLogEvent[];

  beforeEach(() => {
    events = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([clientLogInterceptor])),
        provideHttpClientTesting(),
        { provide: ClientLog, useValue: { record: (event: ClientLogEvent) => events.push(event) } },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  it('records an accepted command by its id, path and status', () => {
    http.post(`${GATEWAY}/api/v1/orders`, { commandId: 'c-1', lines: [] }).subscribe();
    controller
      .expectOne(`${GATEWAY}/api/v1/orders`)
      .flush('order-id', { status: 200, statusText: 'OK' });

    expect(events).toEqual([
      {
        kind: 'command',
        method: 'POST',
        path: '/api/v1/orders',
        commandId: 'c-1',
        outcome: 'accepted',
        status: 200,
      },
    ]);
  });

  it('records a refused command as the mapper reads it, with the correlation id', () => {
    http
      .post(`${GATEWAY}/api/v1/orders`, { commandId: 'c-2' })
      .subscribe({ error: () => undefined });
    controller
      .expectOne(`${GATEWAY}/api/v1/orders`)
      .flush(
        { title: 'Conflict', code: 'already_committed', correlationId: 'corr-409' },
        { status: 409, statusText: 'Conflict' },
      );

    expect(events).toEqual([
      {
        kind: 'command',
        method: 'POST',
        path: '/api/v1/orders',
        commandId: 'c-2',
        outcome: 'alreadyCommitted',
        status: 409,
        correlationId: 'corr-409',
      },
    ]);
  });

  it('records a failed read as its mapped kind, and an answered read not at all', () => {
    http.get(`${GATEWAY}/api/v1/catalog/products`).subscribe();
    controller
      .expectOne(`${GATEWAY}/api/v1/catalog/products`)
      .flush({ items: [], nextCursor: null });
    http.get(`${GATEWAY}/bff/v1/orders/o-1`).subscribe({ error: () => undefined });
    controller
      .expectOne(`${GATEWAY}/bff/v1/orders/o-1`)
      .flush(
        { title: 'Bad Gateway', correlationId: 'corr-502' },
        { status: 502, statusText: 'Bad Gateway' },
      );

    expect(events).toEqual([
      {
        kind: 'failure',
        method: 'GET',
        path: '/bff/v1/orders/o-1',
        status: 502,
        errorKind: 'retry',
        correlationId: 'corr-502',
      },
    ]);
  });

  describe('what is never recorded', () => {
    it('keeps no query string, no other body field and no header', () => {
      const address = {
        line1: '1 Example Street',
        city: 'Doha',
        postalCode: '00000',
        country: 'QA',
      };
      http
        .post(
          `${GATEWAY}/api/v1/orders?code=auth-code&state=s`,
          { commandId: 'c-3', address },
          {
            headers: { authorization: 'Bearer secret-token' },
          },
        )
        .subscribe({ error: () => undefined });
      controller
        .expectOne((r) => r.url.startsWith(`${GATEWAY}/api/v1/orders`))
        .flush(
          { title: 'Unprocessable', correlationId: 'corr-422' },
          { status: 422, statusText: 'Unprocessable' },
        );

      const written = JSON.stringify(events);
      for (const secret of [
        'auth-code',
        'state=',
        'secret-token',
        'Bearer',
        'Example Street',
        'Doha',
        '00000',
      ]) {
        expect(written).not.toContain(secret);
      }
      expect(events[0]).toMatchObject({ path: '/api/v1/orders', commandId: 'c-3' });
    });

    it('records nothing for a request outside the gateway, such as the store’s signed PUT', () => {
      const signed = 'http://127.0.0.1:8333/blueprint/staging/key?X-Amz-Signature=abc';
      http.put(signed, new Blob(['x'])).subscribe({ error: () => undefined });
      controller.expectOne(signed).flush(null, { status: 403, statusText: 'Forbidden' });

      expect(events).toEqual([]);
    });

    it('takes no command id that is not a string', () => {
      http.post(`${GATEWAY}/api/v1/catalog/products`, { commandId: 42 }).subscribe();
      controller.expectOne(`${GATEWAY}/api/v1/catalog/products`).flush('id');

      expect(events).toEqual([]);
    });
  });
});

describe('pathOf', () => {
  it.each([
    ['http://localhost:5000/api/v1/orders?x=1#y', '/api/v1/orders'],
    ['http://localhost:5000', '/'],
    ['/tabs/products?denied=catalog:write', '/tabs/products'],
    ['/?code=abc&state=def', '/'],
    ['/tabs/account#access_token=t', '/tabs/account'],
    ['', '/'],
  ])('%s is %s', (url, path) => {
    expect(pathOf(url)).toBe(path);
  });
});

describe('ClientLog', () => {
  it('is the console adapter by default, at info, under one prefix', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = TestBed.inject(ClientLog);
    expect(log).toBeInstanceOf(ConsoleClientLog);

    log.record({ kind: 'navigation', path: '/tabs/cart' });

    expect(info).toHaveBeenCalledWith('[client-log]', { kind: 'navigation', path: '/tabs/cart' });
    info.mockRestore();
  });
});
