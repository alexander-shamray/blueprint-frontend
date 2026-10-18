import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { AuthService } from '@core/auth/auth.service';
import { ProductImagesApi } from './product-images.api';
import { ProductImageUpload } from './types';

const UPLOAD: ProductImageUpload = {
  uploadUrl: 'http://127.0.0.1:8333/product-images/uploads/s/k.png?X-Amz-Signature=abc',
  headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
  key: 'uploads/s/k.png',
  expiresAt: '2026-10-18T03:02:25Z',
};

describe('ProductImagesApi', () => {
  let api: ProductImagesApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        // The real interceptor, so the bearer question below is asked of the
        // code that would attach one, not of this file's assumption about it.
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { accessToken: () => 'token-value' } },
      ],
    });
    api = TestBed.inject(ProductImagesApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('asks the BFF for an upload with the type and the size, and nothing else', () => {
    const seen = vi.fn();
    api.issue({ contentType: 'image/png', sizeBytes: 4 }).subscribe(seen);

    const request = controller.expectOne('http://localhost:5000/bff/v1/product-images');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ contentType: 'image/png', sizeBytes: 4 });
    expect(request.request.headers.get('Authorization')).toBe('Bearer token-value');

    request.flush(UPLOAD);
    expect(seen).toHaveBeenCalledWith(UPLOAD);
  });

  it('puts the file itself to the signed URL, under the signed Content-Type', () => {
    const file = new Blob(['abcd'], { type: 'image/png' });
    const seen = vi.fn();

    api.upload(UPLOAD, file).subscribe(seen);

    const request = controller.expectOne(UPLOAD.uploadUrl);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toBe(file);
    expect(request.request.headers.get('Content-Type')).toBe('image/png');
    // The browser refuses a script's Content-Length and sends the body's own.
    expect(request.request.headers.has('Content-Length')).toBe(false);

    request.flush(null, { status: 200, statusText: 'OK' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('sends no bearer to the store, which is not the gateway', () => {
    api.upload(UPLOAD, new Blob(['abcd'], { type: 'image/png' })).subscribe();

    const request = controller.expectOne(UPLOAD.uploadUrl);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush(null);
  });
});
