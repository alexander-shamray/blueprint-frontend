import { TERMINAL_STATUSES } from '@core/api/types';

/**
 * How long a screen waits before it opens the order stream again (#111), in
 * one place. The backend closes a stream on its lifetime, on a delivery and on
 * an erasure, and a request can fail to open one at all — a 404 while the
 * projection has not absorbed `OrderPlaced`, a gateway refusal, a dropped
 * connection — so the stream is reopened, and the wait grows while nothing
 * comes of it.
 *
 * The first reopening waits `initialMs`, multiplied by `factor` after each
 * attempt that delivered nothing, until `maxMs`; an attempt that delivered an
 * event starts the back-off again. The server's own `retry:` hint is not read:
 * it asks for a second, which suits a stream that dropped mid-flight and not a
 * request the gateway has just refused.
 */
export const ORDER_STREAM = {
  initialMs: 3_000,
  maxMs: 15_000,
  factor: 2,
} as const;

/** The wait after one that lasted `currentMs`. Never shorter than the first, never longer than the cap. */
export function nextReconnectDelay(currentMs: number): number {
  return Math.min(Math.max(currentMs, ORDER_STREAM.initialMs) * ORDER_STREAM.factor, ORDER_STREAM.maxMs);
}

/** Whether nothing the platform can still say would move this order — the moment a stream is closed. */
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
