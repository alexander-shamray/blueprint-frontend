import { environment } from './environment';

/** The configured gateway base, with any trailing slashes removed. */
function base(): string {
  return environment.gatewayBaseUrl.replace(/\/+$/, '');
}

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
  const gateway = base();
  return url === gateway || url.startsWith(`${gateway}/`) || url.startsWith(`${gateway}?`);
}

/**
 * Whether a gateway request takes the one route the gateway rate-limits with
 * its `anonymous` policy.
 *
 * This is a fact about the ROUTE, and the method is half of it. YARP decides
 * the policy in `Gateway.Api/appsettings.json` before anything about the
 * caller is considered:
 *
 *   catalog-public   GET  /api/v1/catalog/**   -> "anonymous"
 *   catalog-write    POST /api/v1/catalog/**   -> "authenticated"
 *   ordering              /api/v1/orders/**    -> "authenticated"
 *   inventory-admin       /api/v1/inventory/** -> "authenticated"
 *   web-bff               /bff/**              -> "authenticated"
 *
 * So the method genuinely matters here and is not defensive typing: publish
 * POSTs to the exact URL the listing GETs (`catalog.api.ts` builds one `base`
 * for both), and those two are the two sides of the split — a listing is
 * limited by a fixed window of 100 a minute per IP, and a publish to the same
 * path by a token bucket of 300 a minute per subject.
 *
 * Note what this does NOT consult: whether the request carries a bearer. The
 * public listing is limited by the anonymous policy for everyone, signed in
 * or not, because the route is what selects the policy. An earlier version of
 * this file asked about the bearer instead, which quietly filed every
 * signed-in customer's catalogue refusal — the tightest budget in the system,
 * and the one the infinite scroll draws on — against the ordering bucket.
 */
export function isPublicCatalogueRead(method: string, url: string): boolean {
  return method.toUpperCase() === 'GET' && url.startsWith(`${base()}/api/v1/catalog/`);
}
