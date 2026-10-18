import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogApi } from './catalog.api';

describe('CatalogApi', () => {
  let api: CatalogApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CatalogApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CatalogApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('asks for the first page with limit=20 and no cursor parameter', () => {
    api.products(null).subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('20');
    // Absent, not empty: `cursor=` binds as an empty string on the backend and
    // is not the same question as "give me the first page".
    expect(request.request.params.has('cursor')).toBe(false);

    request.flush({ items: [], nextCursor: null });
  });

  it('sends the cursor when one is carried forward', () => {
    api.products('opaque-token').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.params.get('cursor')).toBe('opaque-token');
    request.flush({ items: [], nextCursor: null });
  });

  it('sends a search and a sort beside the cursor when the query names them', () => {
    api.products('opaque-token', { q: 'lamp', sort: 'name' }).subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.params.get('q')).toBe('lamp');
    expect(request.request.params.get('sort')).toBe('name');
    expect(request.request.params.get('cursor')).toBe('opaque-token');
    request.flush({ items: [], nextCursor: null });
  });

  it('sends neither for an empty query, so the server answers its own default', () => {
    api.products(null, { q: '' }).subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    // `q=` would be a search for nothing, and `sort` absent is newest first.
    expect(request.request.params.has('q')).toBe(false);
    expect(request.request.params.has('sort')).toBe(false);
    request.flush({ items: [], nextCursor: null });
  });

  it('reads one product by id, with the id encoded into the path', () => {
    api.product('a/b').subscribe();

    const request = controller.expectOne('http://localhost:5000/api/v1/catalog/products/a%2Fb');

    expect(request.request.method).toBe('GET');
    request.flush({});
  });

  it('posts a publish command and returns the new product id from a 200', () => {
    const command = {
      commandId: '11111111-1111-1111-1111-111111111111',
      name: 'A thing',
      thumbnailUrl: null,
      amount: 12.5,
      currency: 'EUR',
    };
    const seen = vi.fn();

    api.publish(command).subscribe(seen);

    const request = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(command);

    // 200, not 201: ProductEndpoints.cs returns result.ToHttpResult() and
    // ResultExtensions maps a successful Result<Guid> to Results.Ok(value).
    // The body is the bare GUID as a JSON string.
    request.flush('22222222-2222-2222-2222-222222222222', { status: 200, statusText: 'OK' });

    expect(seen).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });

  it("asks for the seller's own first page at /mine, with no cursor parameter", () => {
    api.mine(null).subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products/mine',
    );

    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [], nextCursor: null });
  });

  it('carries the own list cursor forward', () => {
    api.mine('next-page').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products/mine',
    );

    expect(request.request.params.get('cursor')).toBe('next-page');
    request.flush({ items: [], nextCursor: null });
  });

  it('posts a withdrawal to the product, with the command id as the whole body', () => {
    const seen = vi.fn();

    api.withdraw('a/b', { commandId: '33333333-3333-3333-3333-333333333333' }).subscribe(seen);

    const request = controller.expectOne(
      'http://localhost:5000/api/v1/catalog/products/a%2Fb/withdrawal',
    );
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ commandId: '33333333-3333-3333-3333-333333333333' });

    // 204: the Result is bodyless, and ToHttpResult maps it to NoContent.
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
