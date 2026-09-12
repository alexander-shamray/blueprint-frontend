import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { isGatewayUrl } from '@core/config/gateway-url';
import { AuthService } from './auth.service';

/**
 * Attaches the bearer to requests bound for the gateway, and to nothing else
 * (spec §4.3). `isGatewayUrl` compares the URL against the configured base
 * with a boundary check rather than a bare startsWith, because
 * "http://localhost:5000" is a prefix of "http://localhost:50001" and a token
 * sent to the wrong host is a token leaked to it.
 *
 * Registered FIRST of the two interceptors, and `rateLimitInterceptor`
 * depends on that: the gateway partitions its limiter by the subject claim
 * for a request that carried a bearer and by IP for one that did not, so the
 * bucket a 429 belongs to is decided right here.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!isGatewayUrl(request.url)) return next(request);

  const token = inject(AuthService).accessToken();
  if (!token) return next(request);

  return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
