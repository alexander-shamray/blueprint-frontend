import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '@core/config/environment';
import { AuthService } from './auth.service';

/**
 * Attaches the bearer to requests bound for the gateway, and to nothing else
 * (spec §4.3). The URL is compared against the configured base with a boundary
 * check rather than a bare startsWith, because "http://localhost:5000" is a
 * prefix of "http://localhost:50001" and a token sent to the wrong host is a
 * token leaked to it.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const base = environment.gatewayBaseUrl.replace(/\/+$/, '');
  const url = request.url;
  const forGateway = url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);

  if (!forGateway) return next(request);

  const token = inject(AuthService).accessToken();
  if (!token) return next(request);

  return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
