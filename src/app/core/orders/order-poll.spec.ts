import { describe, expect, it } from 'vitest';
import { ORDER_POLL, isTerminal, nextPollDelay } from './order-poll';

describe('order polling', () => {
  it('backs off from the first interval to the cap and stays there', () => {
    const seen: number[] = [];
    let delay: number = ORDER_POLL.initialMs;
    for (let i = 0; i < 6; i++) {
      seen.push(delay);
      delay = nextPollDelay(delay);
    }

    expect(seen).toEqual([3_000, 6_000, 12_000, 15_000, 15_000, 15_000]);
  });

  it('never returns less than the second step, however small the wait it is given', () => {
    expect(nextPollDelay(0)).toBe(6_000);
  });

  it('stops on delivered alone: a cancellation can still be outranked by a later delivery', () => {
    expect(['placed', 'confirmed', 'dispatched'].map(isTerminal)).toEqual([false, false, false]);
    expect(['cancelled', 'out_of_stock', 'declined'].map(isTerminal)).toEqual([false, false, false]);
    expect(isTerminal('delivered')).toBe(true);
  });

  it('keeps asking about a status outside the contract rather than calling it final', () => {
    expect(isTerminal('refunding')).toBe(false);
  });
});
