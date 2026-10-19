import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedAddressApi } from './saved-address.api';
import { Address } from './types';

const URL = 'http://localhost:5000/bff/v1/saved-address';
const HOME: Address = {
  line1: '1 Example Street',
  line2: null,
  city: 'Doha',
  postalCode: '00000',
  country: 'QA',
};

describe('SavedAddressApi', () => {
  let api: SavedAddressApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(SavedAddressApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('reads the saved address from the BFF', () => {
    const seen = vi.fn();
    api.read().subscribe(seen);

    const request = controller.expectOne(URL);
    expect(request.request.method).toBe('GET');
    request.flush(HOME);

    expect(seen).toHaveBeenCalledWith(HOME);
  });

  it('answers null when none is saved, because a 404 is the first state and not a failure', () => {
    const seen = vi.fn();
    const failed = vi.fn();
    api.read().subscribe({ next: seen, error: failed });

    controller.expectOne(URL).flush(null, { status: 404, statusText: 'Not Found' });

    expect(seen).toHaveBeenCalledWith(null);
    expect(failed).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])('still fails on a %i', (status) => {
    const failed = vi.fn();
    api.read().subscribe({ error: failed });

    controller.expectOne(URL).flush(null, { status, statusText: 'Refused' });

    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0][0]).toBeInstanceOf(HttpErrorResponse);
    expect((failed.mock.calls[0][0] as HttpErrorResponse).status).toBe(status);
  });

  it('puts the five fields and answers with the address the server normalised', () => {
    const seen = vi.fn();
    api.save(HOME).subscribe(seen);

    const request = controller.expectOne(URL);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual(HOME);
    request.flush({ ...HOME, city: 'Doha' });

    expect(seen).toHaveBeenCalledWith(HOME);
  });

  it('deletes the saved address', () => {
    const seen = vi.fn();
    api.remove().subscribe(seen);

    const request = controller.expectOne(URL);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });

    expect(seen).toHaveBeenCalledOnce();
  });
});
