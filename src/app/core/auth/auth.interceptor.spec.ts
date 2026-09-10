import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { authInterceptor } from './auth.interceptor';

class StubAuth {
  accessToken = () => 'the-token';
}

describe('authInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useClass: StubAuth },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('attaches the bearer token to gateway requests', () => {
    http.get('http://localhost:5000/api/v1/orders').subscribe();

    expect(controller.expectOne('http://localhost:5000/api/v1/orders').request.headers.get('Authorization'))
      .toBe('Bearer the-token');
  });

  it('attaches nothing to the Keycloak host', () => {
    // A request to the identity provider must never carry the platform's
    // token: the two are different audiences and one is not the other's
    // business.
    http.get('http://localhost:8080/realms/commerce/protocol/openid-connect/token').subscribe();

    expect(
      controller
        .expectOne('http://localhost:8080/realms/commerce/protocol/openid-connect/token')
        .request.headers.has('Authorization'),
    ).toBe(false);
  });

  it('attaches nothing to a host that merely starts with the same characters', () => {
    http.get('http://localhost:50001/api/v1/orders').subscribe();

    expect(controller.expectOne('http://localhost:50001/api/v1/orders').request.headers.has('Authorization'))
      .toBe(false);
  });
});
