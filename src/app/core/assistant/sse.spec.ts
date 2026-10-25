import { describe, expect, it } from 'vitest';
import { readSseFrames } from './sse';

describe('readSseFrames', () => {
  it('reads each named frame with its id, and the retry hint the preamble carries', () => {
    const text = 'retry: 1000\n\nid: 1\nevent: text\ndata: {"delta":"Hi"}\n\n: keep-alive\n\n';

    const read = readSseFrames(text, 0);

    expect(read.frames).toEqual([{ id: '1', event: 'text', data: '{"delta":"Hi"}' }]);
    expect(read.retry).toBe(1000);
    expect(read.consumed).toBe(text.length);
  });

  it('leaves a frame the last chunk cut in half for the next read', () => {
    const whole = 'id: 2\nevent: tool_finished\ndata: {"callId":"a","ok":true}\n\n';
    const half = whole.slice(0, whole.length - 3);

    const first = readSseFrames(half, 0);
    expect(first.frames).toEqual([]);
    expect(first.consumed).toBe(0);

    const second = readSseFrames(whole, first.consumed);
    expect(second.frames).toEqual([
      { id: '2', event: 'tool_finished', data: '{"callId":"a","ok":true}' },
    ]);
  });

  it('reads every line ending, joins data lines, and names an unnamed frame `message`', () => {
    const read = readSseFrames('data: a\r\ndata: b\r\n\r\nid: 3\revent: x\rdata:c\r\r', 0);

    expect(read.frames).toEqual([
      { id: null, event: 'message', data: 'a\nb' },
      { id: '3', event: 'x', data: 'c' },
    ]);
    expect(read.retry).toBeNull();
  });

  it('ignores a retry that is not a number of milliseconds', () => {
    expect(readSseFrames('retry: soon\n\n', 0).retry).toBeNull();
  });
});
