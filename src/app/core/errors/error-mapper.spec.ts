import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_FALLBACK_SECONDS, mapError } from './error-mapper';
import { ProblemDetails } from './problem-details';

function problem(status: number, body: ProblemDetails, headers?: Record<string, string>) {
  return new HttpErrorResponse({
    status,
    statusText: '',
    url: 'http://localhost:5000/api/v1/orders',
    error: body,
    headers: headers
      ? ({ get: (name: string) => headers[name] ?? null } as never)
      : undefined,
  });
}

describe('mapError', () => {
  it('400 with errors becomes a validation model keyed by field', () => {
    const result = mapError(
      problem(400, {
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { Name: ['Name is required.'], Amount: ['Amount must be positive.'] },
        correlationId: 'c-1',
      }),
    );

    expect(result.kind).toBe('validation');
    expect(result.fields).toEqual({
      Name: ['Name is required.'],
      Amount: ['Amount must be positive.'],
    });
    expect(result.correlationId).toBe('c-1');
  });

  it('400 without errors becomes a banner carrying the backend title and detail', () => {
    const result = mapError(
      problem(400, {
        title: 'No products to price',
        detail: 'A quote needs at least one productId.',
        status: 400,
      }),
    );

    expect(result).toMatchObject({
      kind: 'banner',
      title: 'No products to price',
      detail: 'A quote needs at least one productId.',
    });
  });

  it('401 becomes signIn', () => {
    expect(mapError(problem(401, { title: 'Unauthorized', status: 401 })).kind).toBe('signIn');
  });

  it('403 names the permission from the caller, not from the response', () => {
    const result = mapError(problem(403, { title: 'Forbidden', status: 403 }), {
      permission: 'catalog:write',
    });

    expect(result.kind).toBe('forbidden');
    expect(result.permission).toBe('catalog:write');
  });

  it('404 becomes a banner with the backend text', () => {
    const result = mapError(problem(404, { title: 'Not Found', detail: 'No such order.', status: 404 }));

    expect(result).toMatchObject({ kind: 'banner', title: 'Not Found', detail: 'No such order.' });
  });

  it('409 command.already_committed must not be retried', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'command.already_committed',
        detail:
          'This command has already been applied and its result is no longer available; read the resource rather than retrying.',
      }),
    );

    expect(result.kind).toBe('alreadyCommitted');
    expect(result.detail).toContain('already been applied');
  });

  it('409 request.in_progress is a distinct kind that invites a retry', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'request.in_progress',
        detail: 'A request with this command identifier is already in progress. Retry.',
      }),
    );

    expect(result.kind).toBe('inProgress');
  });

  it('409 request.concurrency_conflict is a third distinct kind', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'request.concurrency_conflict',
        detail: 'The resource was modified by another request. Re-read it and retry.',
      }),
    );

    expect(result.kind).toBe('concurrencyConflict');
  });

  it('409 with no code falls back to the most cautious of the three', () => {
    expect(mapError(problem(409, { status: 409 })).kind).toBe('alreadyCommitted');
  });

  it('422 shows the backend title and detail verbatim', () => {
    const result = mapError(
      problem(422, {
        title: 'Unprocessable Entity',
        detail: 'An order must hold at least one item.',
        status: 422,
        code: 'order.empty',
      }),
    );

    expect(result).toMatchObject({
      kind: 'rule',
      title: 'Unprocessable Entity',
      detail: 'An order must hold at least one item.',
    });
  });

  it('429 parses Retry-After when the gateway exposes it', () => {
    const result = mapError(
      problem(429, { title: 'Too many requests', status: 429 }, { 'Retry-After': '17' }),
    );

    expect(result.kind).toBe('rateLimited');
    expect(result.retryAfterSeconds).toBe(17);
    expect(result.retryAfterIsFallback).toBe(false);
  });

  it('429 falls back and says so when Retry-After is unreadable', () => {
    const result = mapError(problem(429, { title: 'Too many requests', status: 429 }));

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('429 falls back when Retry-After is present but empty', () => {
    const result = mapError(
      problem(429, { title: 'Too many requests', status: 429 }, { 'Retry-After': '' }),
    );

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('429 falls back when Retry-After is whitespace-only', () => {
    const result = mapError(
      problem(429, { title: 'Too many requests', status: 429 }, { 'Retry-After': '   ' }),
    );

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('429 falls back when Retry-After is non-numeric', () => {
    const result = mapError(
      problem(429, { title: 'Too many requests', status: 429 }, { 'Retry-After': 'soon' }),
    );

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('429 falls back when Retry-After is an HTTP-date (out of contract; the gateway only sends seconds)', () => {
    const result = mapError(
      problem(
        429,
        { title: 'Too many requests', status: 429 },
        { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      ),
    );

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('503 becomes unavailable', () => {
    expect(mapError(problem(503, { title: 'Service Unavailable', status: 503 })).kind).toBe(
      'unavailable',
    );
  });

  it('500 becomes retry and carries the correlation id from the body', () => {
    const result = mapError(
      problem(500, { title: 'An error occurred', status: 500, correlationId: 'abc-123' }),
    );

    expect(result.kind).toBe('retry');
    expect(result.correlationId).toBe('abc-123');
  });

  it('a network failure is status 0 and maps to retry with no correlation id', () => {
    const result = mapError(
      new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', error: new ProgressEvent('error') }),
    );

    expect(result.kind).toBe('retry');
    expect(result.correlationId).toBeUndefined();
  });
});
