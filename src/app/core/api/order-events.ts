import { OrderDetail } from './types';

/** One `order` event of `GET /bff/v1/orders/{id}/events`: the row's `AsOf` as the id, and the order as it stood. */
export interface OrderStreamEvent {
  readonly id: string | null;
  readonly order: OrderDetail;
}

/** Web.Bff/Orders/OrderEventStream.cs — `EventName`; any other event is not this client's to read. */
const EVENT_NAME = 'order';

/** A blank line ends a frame, in whichever of the three line endings the server wrote. */
const FRAME_END = /\r\n\r\n|\n\n|\r\r/;

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
  const events: OrderStreamEvent[] = [];
  let consumed = from;

  for (;;) {
    const rest = text.slice(consumed);
    const end = FRAME_END.exec(rest);
    if (end === null) break;

    consumed += end.index + end[0].length;
    const event = readFrame(rest.slice(0, end.index));
    if (event !== null) events.push(event);
  }

  return { events, consumed };
}

function readFrame(frame: string): OrderStreamEvent | null {
  let id: string | null = null;
  let name = 'message';
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }

  if (name !== EVENT_NAME || data.length === 0) return null;

  try {
    return { id, order: JSON.parse(data.join('\n')) as OrderDetail };
  } catch {
    return null;
  }
}
