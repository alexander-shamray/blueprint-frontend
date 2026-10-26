import { SseFrame, readSseFrames } from './sse';
import { OrderDetail } from './types';

/** One `order` event of `GET /bff/v1/orders/{id}/events`: the row's `AsOf` as the id, and the order as it stood. */
export interface OrderStreamEvent {
  readonly id: string | null;
  readonly order: OrderDetail;
}

/** Web.Bff/Orders/OrderEventStream.cs — `EventName`; any other event is not this client's to read. */
const EVENT_NAME = 'order';

/**
 * The events in `text` that complete after `from`, and where the next read
 * should start.
 *
 * `text` is the response so far, whole, because that is what a progress event
 * carries: a frame the last chunk cut in half stays unread until its blank
 * line arrives, and `consumed` stops before it. Comments (the server's
 * `: keep-alive`), the `retry:` line and events with another name are framing
 * and are dropped. A frame whose data is not JSON is dropped as well rather
 * than ending the stream: the next event carries the whole order again.
 */
export function readOrderEvents(
  text: string,
  from: number,
): { readonly events: readonly OrderStreamEvent[]; readonly consumed: number } {
  const { frames, consumed } = readSseFrames(text, from);
  const events: OrderStreamEvent[] = [];

  for (const frame of frames) {
    const event = readOrder(frame);
    if (event !== null) events.push(event);
  }

  return { events, consumed };
}

function readOrder(frame: SseFrame): OrderStreamEvent | null {
  if (frame.event !== EVENT_NAME) return null;

  try {
    return { id: frame.id, order: JSON.parse(frame.data) as OrderDetail };
  } catch {
    return null;
  }
}
