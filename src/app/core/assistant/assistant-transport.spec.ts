import { HttpClient, HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_CLOSED } from './assistant-client';
import { ASSISTANT_STREAM, AssistantTransport, HttpEventSource } from './assistant-transport';

describe('AssistantTransport', () => {
  let transport: AssistantTransport;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    transport = TestBed.inject(AssistantTransport);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    vi.useRealTimers();
  });

  it("is the BFF's assistant group, through the gateway's /bff", () => {
    expect(transport.base).toMatch(/\/bff\/v1\/assistant$/);
  });

  describe('fetch', () => {
    it('sends the method, the headers and the body, and answers a Response', async () => {
      const answer = transport.fetch(`${transport.base}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });

      const request = controller.expectOne(`${transport.base}/conversations`);
      expect(request.request.method).toBe('POST');
      expect(request.request.headers.get('Content-Type')).toBe('application/json');
      expect(request.request.body).toBe('{"a":1}');
      request.flush('{"id":"c1"}');

      const response = await answer;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'c1' });
    });

    it('resolves an error status as a Response, as fetch does, with its problem body', async () => {
      const answer = transport.fetch(transport.base);

      controller
        .expectOne(transport.base)
        .flush('{"title":"A turn is running"}', { status: 409, statusText: 'Conflict' });

      const response = await answer;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ title: 'A turn is running' });
    });

    it('gives a 204 no body', async () => {
      const answer = transport.fetch(`${transport.base}/x`, { method: 'DELETE' });

      controller
        .expectOne(`${transport.base}/x`)
        .flush(null, { status: 204, statusText: 'No Content' });

      const response = await answer;
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    it('rejects a request that reached no host', async () => {
      const answer = transport.fetch(transport.base);

      controller.expectOne(transport.base).error(new ProgressEvent('error'));

      await expect(answer).rejects.toBeInstanceOf(TypeError);
    });

    it('cancels the request when its signal aborts, and refuses one already aborted', async () => {
      const abort = new AbortController();
      const answer = transport.fetch(transport.base, { signal: abort.signal });
      const request = controller.expectOne(transport.base);

      abort.abort(new DOMException('timed out', 'TimeoutError'));

      await expect(answer).rejects.toThrow('timed out');
      expect(request.cancelled).toBe(true);

      await expect(transport.fetch(transport.base, { signal: abort.signal })).rejects.toThrow(
        'timed out',
      );
    });
  });

  describe('HttpEventSource', () => {
    const url = 'http://gateway/bff/v1/assistant/conversations/c1/events?after=0';

    function open() {
      const source = new HttpEventSource(TestBed.inject(HttpClient), url);
      const seen: string[] = [];
      for (const name of ['text', 'error']) {
        source.addEventListener(name, (e) =>
          seen.push(
            `${name}:${String(e.data ?? '-')}:${e.lastEventId ?? '-'}:${source.readyState}`,
          ),
        );
      }
      return { source, seen };
    }

    it('asks for an event stream and hands on each named event with its id', () => {
      const { source, seen } = open();
      const request = controller.expectOne(url);
      expect(request.request.headers.get('Accept')).toBe('text/event-stream');
      expect(request.request.headers.has('Last-Event-ID')).toBe(false);

      request.event({ type: HttpEventType.ResponseHeader } as never);
      const first = 'retry: 1000\n\nid: 1\nevent: text\ndata: {"delta":"Hi"}\n\n';
      request.event({ type: HttpEventType.DownloadProgress, loaded: 0, partialText: first });
      request.event({
        type: HttpEventType.DownloadProgress,
        loaded: 0,
        partialText: `${first}id: 2\nevent: text\ndata: "x"\n\n`,
      });

      expect(seen).toEqual(['text:{"delta":"Hi"}:1:1', 'text:"x":2:1']);
      source.close();
    });

    it('reconnects with Last-Event-ID after the server ends the stream, on its retry hint', () => {
      vi.useFakeTimers();
      const { source } = open();
      const first = controller.expectOne(url);
      first.event({
        type: HttpEventType.DownloadProgress,
        loaded: 0,
        partialText: 'retry: 500\n\nid: 4\nevent: text\ndata: "x"\n\n',
      });
      first.flush('retry: 500\n\nid: 4\nevent: text\ndata: "x"\n\n');

      vi.advanceTimersByTime(499);
      controller.expectNone(url);
      vi.advanceTimersByTime(1);

      const second = controller.expectOne(url);
      expect(second.request.headers.get('Last-Event-ID')).toBe('4');
      source.close();
      expect(second.cancelled).toBe(true);
    });

    it('gives up on a 404, CLOSED before its error fires, and asks again for nothing', () => {
      vi.useFakeTimers();
      const { source, seen } = open();

      controller.expectOne(url).flush('', { status: 404, statusText: 'Not Found' });
      vi.advanceTimersByTime(ASSISTANT_STREAM.maxMs);

      expect(source.readyState).toBe(STREAM_CLOSED);
      expect(seen).toEqual([`error:-:-:${STREAM_CLOSED}`]);
      controller.expectNone(url);
    });

    it('gives up on a 401 as well: the caller is no longer admitted', () => {
      const { source } = open();

      controller.expectOne(url).flush('', { status: 401, statusText: 'Unauthorized' });

      expect(source.readyState).toBe(STREAM_CLOSED);
    });

    it('reconnects after a failure a retry can mend, waiting longer each time', () => {
      vi.useFakeTimers();
      const { source, seen } = open();

      controller.expectOne(url).flush('', { status: 503, statusText: 'Unavailable' });
      expect(seen).toEqual(['error:-:-:0']);
      vi.advanceTimersByTime(ASSISTANT_STREAM.initialMs);
      controller.expectOne(url).error(new ProgressEvent('error'));

      vi.advanceTimersByTime(ASSISTANT_STREAM.initialMs);
      controller.expectNone(url);
      vi.advanceTimersByTime(ASSISTANT_STREAM.initialMs);
      controller.expectOne(url);

      source.close();
    });

    it('fires nothing after it is closed', () => {
      const { source, seen } = open();
      const request = controller.expectOne(url);

      source.close();

      expect(request.cancelled).toBe(true);
      expect(seen).toEqual([]);
    });
  });
});
