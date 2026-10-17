import { describe, expect, it } from 'vitest';
import { readOrderEvents } from './order-events';

const ORDER = { orderId: 'o1', status: 'placed' };

function frame(id: string, order: object = ORDER, eol = '\n'): string {
  return `id: ${id}${eol}event: order${eol}data: ${JSON.stringify(order)}${eol}${eol}`;
}

describe('readOrderEvents', () => {
  it('reads the id and the order of an event, after the retry hint', () => {
    const { events, consumed } = readOrderEvents(`retry: 1000\n\n${frame('t1')}`, 0);

    expect(events).toEqual([{ id: 't1', order: ORDER }]);
    expect(consumed).toBe(`retry: 1000\n\n${frame('t1')}`.length);
  });

  it('leaves a frame the last chunk cut in half for the next read', () => {
    const whole = frame('t1');
    const half = whole.slice(0, whole.length - 5);

    const first = readOrderEvents(half, 0);
    expect(first.events).toEqual([]);
    expect(first.consumed).toBe(0);

    const second = readOrderEvents(whole, first.consumed);
    expect(second.events).toEqual([{ id: 't1', order: ORDER }]);
  });

  it('reads each event once however many times it is handed the growing text', () => {
    const one = frame('t1');
    const two = one + frame('t2', { ...ORDER, status: 'confirmed' });

    const first = readOrderEvents(one, 0);
    const second = readOrderEvents(two, first.consumed);
    const third = readOrderEvents(two, second.consumed);

    expect(first.events.map((e) => e.id)).toEqual(['t1']);
    expect(second.events.map((e) => e.id)).toEqual(['t2']);
    expect(third.events).toEqual([]);
  });

  it('drops the keep-alive comment and an event of another name', () => {
    const text = `: keep-alive\n\nevent: other\ndata: {}\n\n${frame('t1')}`;

    expect(readOrderEvents(text, 0).events.map((e) => e.id)).toEqual(['t1']);
  });

  it('reads CRLF and a data field split over lines', () => {
    const crlf = readOrderEvents(frame('t1', ORDER, '\r\n'), 0);
    expect(crlf.events).toEqual([{ id: 't1', order: ORDER }]);

    const split = readOrderEvents('event: order\ndata: {"orderId":\ndata: "o1"}\n\n', 0);
    expect(split.events).toEqual([{ id: null, order: { orderId: 'o1' } }]);
  });

  it('drops a frame whose data is not JSON and goes on to the next', () => {
    const text = `event: order\ndata: not json\n\n${frame('t1')}`;

    expect(readOrderEvents(text, 0).events.map((e) => e.id)).toEqual(['t1']);
  });
});
