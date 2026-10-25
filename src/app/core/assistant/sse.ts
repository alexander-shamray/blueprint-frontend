/** One Server-Sent Event as the wire framed it: its fields, before anybody reads its data. */
export interface SseFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

/** A blank line ends a frame, in whichever of the three line endings the server wrote. */
const FRAME_END = /\r\n\r\n|\n\n|\r\r/;

/**
 * The frames in `text` that complete after `from`, the server's last `retry:`
 * hint among them, and where the next read should start.
 *
 * `text` is the response so far, whole, because that is what a download
 * progress event carries: a frame the last chunk cut in half stays unread
 * until its blank line arrives, and `consumed` stops before it. A comment, and
 * a frame with no `data:` line (the `retry:` preamble), dispatches nothing,
 * as the HTML standard's event stream says.
 *
 * The same framing as `core/api/order-events.ts`'s, which reads one event
 * name and parses its data in place; this one hands every named frame on,
 * because the assistant's protocol has six.
 */
export function readSseFrames(
  text: string,
  from: number,
): {
  readonly frames: readonly SseFrame[];
  readonly retry: number | null;
  readonly consumed: number;
} {
  const frames: SseFrame[] = [];
  let retry: number | null = null;
  let consumed = from;

  for (;;) {
    const rest = text.slice(consumed);
    const end = FRAME_END.exec(rest);
    if (end === null) break;

    consumed += end.index + end[0].length;
    const read = readFrame(rest.slice(0, end.index));
    if (read.retry !== null) retry = read.retry;
    if (read.frame !== null) frames.push(read.frame);
  }

  return { frames, retry, consumed };
}

function readFrame(block: string): { frame: SseFrame | null; retry: number | null } {
  let id: string | null = null;
  let event = 'message';
  let retry: number | null = null;
  const data: string[] = [];

  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }

  return { frame: data.length === 0 ? null : { id, event, data: data.join('\n') }, retry };
}
