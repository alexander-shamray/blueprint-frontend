import { environment } from './environment';

/**
 * Whether a request URL is bound for the gateway (spec §4.3, and §11: the
 * gateway is the only host this client calls).
 *
 * A boundary check rather than a bare `startsWith`, because
 * `http://localhost:5000` is a prefix of `http://localhost:50001` — and the
 * two interceptors that ask this question both answer it with something a
 * caller cannot undo. `authInterceptor` attaches the bearer, where a wrong
 * answer is a token leaked to another host. `rateLimitInterceptor` files a
 * 429 against a gateway bucket, where a wrong answer disables the app's
 * actions on the strength of someone else's limiter — Keycloak's, in the one
 * case that actually arises, since angular-oauth2-oidc talks to the token
 * endpoint through this same HttpClient.
 *
 * It lives here rather than in either interceptor because it was in both:
 * one copy that drifts is how a check like this stops holding on one of the
 * two paths without anything failing.
 */
export function isGatewayUrl(url: string): boolean {
  const base = environment.gatewayBaseUrl.replace(/\/+$/, '');
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}
