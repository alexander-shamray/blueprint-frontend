import { TERMINAL_STATUSES } from '@core/api/types';

/**
 * How often a screen asks the order read for news, in one place (#96). There
 * is no stream on the read — the backend's §10.7 serves a projection and
 * nothing pushes — so polling is the honest mechanism, and when the read
 * grows a stream this file and its callers are deleted (#111).
 *
 * The first request goes out at once; then every `initialMs`, multiplied by
 * `factor` after each answer, until `maxMs`. So a fresh order is asked about
 * at 0, 3, 9, 21 and 36 seconds and every 15 after that: quick while the
 * saga is likely to move, and then well inside the gateway's `authenticated`
 * bucket, which the same buyer's other actions draw on.
 */
export const ORDER_POLL = {
  initialMs: 3_000,
  maxMs: 15_000,
  factor: 2,
} as const;

/** The wait after one that lasted `currentMs`. Never shorter than the first, never longer than the cap. */
export function nextPollDelay(currentMs: number): number {
  return Math.min(Math.max(currentMs, ORDER_POLL.initialMs) * ORDER_POLL.factor, ORDER_POLL.maxMs);
}

/** Whether nothing the platform can still say would move this order — the moment a poll stops. */
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
