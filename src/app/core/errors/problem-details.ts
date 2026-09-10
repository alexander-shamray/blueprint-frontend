/**
 * RFC 9457, as the platform sends it. `title` and `detail` are the backend's
 * words and are rendered as sent (spec §6) — the client authors no error text
 * beyond the six generic banners.
 *
 * The three extension members are Common.Web's, not the RFC's:
 *   code           the stable identifier a client switches on. ResultExtensions.cs
 *                  puts Error.Code here; the three 409 handlers put their own.
 *                  RFC 9457 makes `detail` human-readable, so switching on prose
 *                  is what this member exists to prevent.
 *   correlationId  ProblemDetailsExtensions.cs:57. Read from the BODY and never
 *                  from the X-Correlation-Id header: that header is not
 *                  CORS-safelisted and the gateway does not expose it, so
 *                  script cannot see it cross-origin.
 *   traceId        ProblemDetailsExtensions.cs:60.
 */
export interface ProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  /** ValidationProblemDetails only. Keyed by field, as ValidationExceptionHandler.cs:35 builds it. */
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

export function isProblemDetails(body: unknown): body is ProblemDetails {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}
