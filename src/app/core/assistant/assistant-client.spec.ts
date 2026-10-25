import { describe, expect, it } from 'vitest';
import {
  AssistantClient,
  AssistantConversation,
  ConversationState,
  EMPTY_CONVERSATION,
  IdStore,
} from './assistant-client';
import { ClientToolRegistry, viewTool } from './client-tools';
import { ConversationView, OpenConversation } from './protocol';
import { FakeHost, json, settle } from './testing/assistant-fakes';

/**
 * Copied from `blueprint-admin`'s
 * `src/Admin.Web/src/app/assistant/assistant-client.spec.ts` with the client
 * it covers, so the shared part is held to the same cases in both clients.
 */
const BASE = '/bff/v1/assistant';

const OPENING: OpenConversation = {
  client: { name: 'test', version: '1' },
  locale: 'en-US',
  catalogue: [{ id: 'cart', label: 'Cart', where: '/tabs/cart', help: 'The basket.' }],
  clientTools: [],
  hostOptions: null,
};

const ENDED = {
  reason: 'done',
  category: null,
  usage: { input: 0, output: 0, cached: 0 },
  total: { input: 0, output: 0, cached: 0 },
};

function memoryIds(initial: string | null = null): IdStore & { id: string | null } {
  const store = {
    id: initial,
    get: () => store.id,
    set: (id: string | null) => {
      store.id = id;
    },
  };
  return store;
}

function setup(ids = memoryIds()) {
  const host = new FakeHost()
    .on('POST', /\/conversations$/, () => json({ id: 'c1' }))
    .on('POST', /\/turns$/, () => new Response(null, { status: 202 }))
    .on('POST', /\/tool-results$/, () => new Response(null, { status: 204 }))
    .on('POST', /\/cancel$/, () => new Response(null, { status: 204 }));
  const tools = new ClientToolRegistry();
  const opened: string[] = [];
  tools.register({
    descriptor: viewTool('open_page', 'Open a page', 'Opens one.', { type: 'object' }),
    run: (input) => {
      opened.push(String(input['page']));
      return { ok: true, content: `opened /${String(input['page'])}` };
    },
  });
  const states: ConversationState[] = [];
  const client = new AssistantClient(BASE, host.fetch, host.openStream);
  const conversation = new AssistantConversation(
    client,
    tools,
    () => OPENING,
    ids,
    (s) => states.push(s),
  );
  return { host, conversation, states, opened, ids, tools };
}

/** Two tools, one that waits to be released and one that does not, recording the order. */
function slowAndQuick(tools: ClientToolRegistry) {
  const order: string[] = [];
  const control = { release: (): void => undefined };
  tools.register({
    descriptor: viewTool('slow', 'Slow', 'Takes a while.', { type: 'object' }),
    run: () =>
      new Promise((resolve) => {
        order.push('slow:start');
        control.release = () => {
          order.push('slow:end');
          resolve({ ok: true, content: '' });
        };
      }),
  });
  tools.register({
    descriptor: viewTool('quick', 'Quick', 'Does not.', { type: 'object' }),
    run: () => {
      order.push('quick');
      return { ok: true, content: '' };
    },
  });
  return { order, control };
}

function answeredCalls(host: FakeHost): string[] {
  return host.requests
    .filter((r) => r.url.endsWith('/tool-results'))
    .map((r) => (r.body as { callId: string }).callId);
}

describe('AssistantConversation', () => {
  it('opens a conversation on the first message, keeps its id and follows its stream', async () => {
    const { host, conversation, ids } = setup();

    await conversation.send('where is my order?', { route: '/tabs/orders' }, 'en-US');

    expect(ids.id).toBe('c1');
    expect(host.requests.find((r) => r.url.endsWith('/conversations'))?.body).toEqual(OPENING);
    expect(host.requests.find((r) => r.url.endsWith('/turns'))?.body).toEqual({
      text: 'where is my order?',
      context: { route: '/tabs/orders' },
      locale: 'en-US',
      hostOptions: null,
    });
    expect(host.stream.url).toBe(`${BASE}/conversations/c1/events?after=0`);
    expect(conversation.current.running).toBe(true);
    expect(conversation.current.items).toEqual([{ kind: 'operator', text: 'where is my order?' }]);
  });

  it('runs the client calls of a round one after another, in the order they came', async () => {
    const { host, conversation, tools } = setup();
    const { order, control } = slowAndQuick(tools);
    await conversation.send('go', null, 'en-US');

    host.stream.emit('client_tool_call', { callId: 'a', name: 'slow', input: {} }, 1);
    host.stream.emit('client_tool_call', { callId: 'b', name: 'quick', input: {} }, 2);
    await settle();
    expect(order).toEqual(['slow:start']);

    control.release();
    await settle();
    expect(order).toEqual(['slow:start', 'slow:end', 'quick']);
    expect(answeredCalls(host)).toEqual(['a', 'b']);
  });

  it('does not run a queued call whose turn ended while it waited', async () => {
    const { host, conversation, tools } = setup();
    const { order, control } = slowAndQuick(tools);
    await conversation.send('go', null, 'en-US');
    host.stream.emit('client_tool_call', { callId: 'a', name: 'slow', input: {} }, 1);
    host.stream.emit('client_tool_call', { callId: 'b', name: 'quick', input: {} }, 2);
    await settle();

    // The turn is cancelled while `quick` waits behind `slow`.
    host.stream.emit('turn_ended', { ...ENDED, reason: 'cancelled' }, 3);
    await settle();
    control.release();
    await settle();

    expect(order).toEqual(['slow:start', 'slow:end']);
    expect(answeredCalls(host)).toEqual(['a']);
  });

  it('does not run a queued call of an ended turn once a new message runs another', async () => {
    const { host, conversation, tools } = setup();
    const { order, control } = slowAndQuick(tools);
    await conversation.send('go', null, 'en-US');
    host.stream.emit('client_tool_call', { callId: 'a', name: 'slow', input: {} }, 1);
    host.stream.emit('client_tool_call', { callId: 'b', name: 'quick', input: {} }, 2);
    await settle();
    host.stream.emit('turn_ended', { ...ENDED, reason: 'cancelled' }, 3);
    await settle();

    // Sent again before `slow` returns: running, but another turn.
    await conversation.send('again', null, 'en-US');
    control.release();
    await settle();

    expect(order).toEqual(['slow:start', 'slow:end']);
  });

  it('does not run a queued call after the conversation is started over', async () => {
    const { host, conversation, tools } = setup();
    const { order, control } = slowAndQuick(tools);
    host.on('DELETE', /\/conversations\/c1$/, () => new Response(null, { status: 204 }));
    await conversation.send('go', null, 'en-US');
    host.stream.emit('client_tool_call', { callId: 'a', name: 'slow', input: {} }, 1);
    host.stream.emit('client_tool_call', { callId: 'b', name: 'quick', input: {} }, 2);
    await settle();

    await conversation.startOver();
    control.release();
    await settle();

    expect(order).toEqual(['slow:start', 'slow:end']);
  });

  it('gives each answer a deadline, and a call behind a failed answer still runs', async () => {
    const { host, conversation, tools } = setup();
    const order: string[] = [];
    tools.register({
      descriptor: viewTool('quick', 'Quick', 'Does not.', { type: 'object' }),
      run: (input) => {
        order.push(String(input['n']));
        return { ok: true, content: '' };
      },
    });
    // The first answer never lands, as when the host stops responding.
    host.on('POST', /\/tool-results$/, (body) => {
      if ((body as { callId: string }).callId === 'a') {
        throw new DOMException('timed out', 'TimeoutError');
      }
      return new Response(null, { status: 204 });
    });
    await conversation.send('go', null, 'en-US');

    host.stream.emit('client_tool_call', { callId: 'a', name: 'quick', input: { n: 1 } }, 1);
    host.stream.emit('client_tool_call', { callId: 'b', name: 'quick', input: { n: 2 } }, 2);
    await settle();

    const answers = host.requests.filter((r) => r.url.endsWith('/tool-results'));
    expect(answers.map((r) => (r.body as { callId: string }).callId)).toEqual(['a', 'b']);
    expect(answers.every((r) => r.signal instanceof AbortSignal)).toBe(true);
    expect(order).toEqual(['1', '2']);
  });

  it('streams the reply, runs a client tool, posts its result and ends', async () => {
    const { host, conversation, opened } = setup();
    host.on('GET', /\/conversations\/c1$/, () =>
      json({
        id: 'c1',
        items: [
          { kind: 'operator', text: 'cart?' },
          { kind: 'reply', text: 'Opening the cart. ' },
          {
            kind: 'tool',
            callId: 'k1',
            name: 'open_page',
            side: 'client',
            args: { page: 'cart' },
            ok: true,
          },
          { kind: 'reply', text: 'It is open.' },
          { kind: 'end', reason: 'done', category: null },
        ],
        running: false,
        lastEventId: 7,
        pendingCalls: [],
      } satisfies ConversationView),
    );
    await conversation.send('cart?', null, 'en-US');
    const stream = host.stream;

    stream.emit('text', { delta: 'Opening ' }, 1);
    stream.emit('text', { delta: 'the cart. ' }, 2);
    stream.emit(
      'tool_started',
      { callId: 'k1', name: 'open_page', side: 'client', args: { page: 'cart' } },
      3,
    );
    stream.emit(
      'client_tool_call',
      { callId: 'k1', name: 'open_page', input: { page: 'cart' } },
      4,
    );
    await settle();

    expect(opened).toEqual(['cart']);
    expect(host.requests.find((r) => r.url.endsWith('/tool-results'))?.body).toEqual({
      callId: 'k1',
      ok: true,
      content: 'opened /cart',
    });
    expect(conversation.current.items.slice(1)).toEqual([
      { kind: 'reply', text: 'Opening the cart. ' },
      {
        kind: 'tool',
        callId: 'k1',
        name: 'open_page',
        side: 'client',
        args: { page: 'cart' },
        ok: null,
      },
    ]);

    stream.emit('tool_finished', { callId: 'k1', ok: true }, 5);
    stream.emit('text', { delta: 'It is open.' }, 6);
    stream.emit('turn_ended', ENDED, 7);
    await settle();

    expect(conversation.current.running).toBe(false);
    expect(conversation.current.lastEventId).toBe(7);
    expect(conversation.current.items.at(-1)).toEqual({
      kind: 'end',
      reason: 'done',
      category: null,
    });
    // Idle and nothing visible: the stream is closed, and nothing is left open.
    expect(stream.closed).toBe(true);
  });

  it('answers a client tool call once, even when it arrives again under a later id', async () => {
    const { host, conversation, opened } = setup();
    await conversation.send('cart?', null, 'en-US');

    host.stream.emit(
      'client_tool_call',
      { callId: 'k1', name: 'open_page', input: { page: 'cart' } },
      1,
    );
    host.stream.emit(
      'client_tool_call',
      { callId: 'k1', name: 'open_page', input: { page: 'cart' } },
      2,
    );
    await settle();

    expect(opened).toEqual(['cart']);
  });

  it('after a reload answers a client call the read says is still waiting', async () => {
    const { host, conversation, opened } = setup(memoryIds('c1'));
    host.on('GET', /\/conversations\/c1$/, () =>
      json({
        id: 'c1',
        items: [
          {
            kind: 'tool',
            callId: 'k1',
            name: 'open_page',
            side: 'client',
            args: { page: 'cart' },
            ok: null,
          },
        ],
        running: true,
        lastEventId: 3,
        pendingCalls: [{ callId: 'k1', name: 'open_page', input: { page: 'cart' } }],
      } satisfies ConversationView),
    );

    await conversation.resume();
    await settle();

    expect(opened).toEqual(['cart']);
    expect(host.requests.find((r) => r.url.endsWith('/tool-results'))?.body).toEqual({
      callId: 'k1',
      ok: true,
      content: 'opened /cart',
    });
  });

  it('a read begun before a new message never undoes it', async () => {
    const { host, conversation } = setup();
    // The read a turn's end starts answers as the host stood then.
    host.on('GET', /\/conversations\/c1$/, () =>
      json({ id: 'c1', items: [], running: false, lastEventId: 1, pendingCalls: [] }),
    );
    await conversation.send('one', null, 'en-US');

    host.stream.emit('turn_ended', ENDED, 1);
    // Sent before that read has come back.
    await conversation.send('two', null, 'en-US');
    await settle();

    expect(conversation.current.running).toBe(true);
    expect(conversation.current.items.at(-1)).toEqual({ kind: 'operator', text: 'two' });
  });

  it('when the stream is given up and the host still holds it, follows on', async () => {
    const { host, conversation, opened } = setup();
    await conversation.send('cart?', null, 'en-US');
    const waiting = {
      kind: 'tool',
      callId: 'k1',
      name: 'open_page',
      side: 'client',
      args: { page: 'cart' },
      ok: null,
    } as const;
    host.on('GET', /\/conversations\/c1$/, () =>
      json({
        id: 'c1',
        items: [{ kind: 'operator', text: 'cart?' }, waiting],
        running: true,
        lastEventId: 5,
        pendingCalls: [{ callId: 'k1', name: 'open_page', input: { page: 'cart' } }],
      } satisfies ConversationView),
    );

    host.stream.lose();
    await settle();

    expect(conversation.current.items.at(-1)).toEqual(waiting);
    expect(host.stream.url).toBe(`${BASE}/conversations/c1/events?after=5`);
    expect(opened).toEqual(['cart']);
  });

  it('a read of a conversation started over since is dropped', async () => {
    const { host, conversation, ids } = setup();
    await conversation.send('cart?', null, 'en-US');
    host.on('GET', /\/conversations\/c1$/, () =>
      json({
        id: 'c1',
        items: [{ kind: 'operator', text: 'cart?' }],
        running: true,
        lastEventId: 5,
        pendingCalls: [],
      }),
    );

    host.stream.lose();
    await conversation.startOver();
    await settle();

    expect(ids.id).toBeNull();
    expect(conversation.current.items).toEqual([]);
  });

  it('when the stream is given up and the host has forgotten it, says so', async () => {
    const { host, conversation, ids } = setup();
    await conversation.send('cart?', null, 'en-US');

    host.stream.lose();
    await settle();

    expect(ids.id).toBeNull();
    expect(conversation.current.running).toBe(false);
    expect(conversation.current.problem).toEqual({ code: 'gone', detail: null });
  });

  it('after a reload redraws from the read and follows on from its lastEventId', async () => {
    const { host, conversation } = setup(memoryIds('c1'));
    host.on('GET', /\/conversations\/c1$/, () =>
      json({
        id: 'c1',
        items: [
          { kind: 'operator', text: 'where?' },
          { kind: 'reply', text: 'Open' },
        ],
        running: true,
        lastEventId: 12,
        pendingCalls: [],
      }),
    );

    await conversation.resume();

    expect(conversation.current.items).toEqual([
      { kind: 'operator', text: 'where?' },
      { kind: 'reply', text: 'Open' },
    ]);
    expect(host.stream.url).toBe(`${BASE}/conversations/c1/events?after=12`);

    host.stream.emit('text', { delta: 'ing the cart.' }, 12);
    host.stream.emit('text', { delta: 'ing the cart.' }, 13);
    expect(conversation.current.items.at(-1)).toEqual({ kind: 'reply', text: 'Opening the cart.' });
  });

  it('forgets an id the host no longer holds', async () => {
    const ids = memoryIds('gone');
    const { host, conversation } = setup(ids);

    await conversation.resume();

    expect(ids.id).toBeNull();
    expect(host.streams).toEqual([]);
  });

  it('holds no stream while idle and hidden, and opens one while visible', async () => {
    const { host, conversation } = setup(memoryIds('c1'));
    host.on('GET', /\/conversations\/c1$/, () =>
      json({ id: 'c1', items: [], running: false, lastEventId: 3, pendingCalls: [] }),
    );
    await conversation.resume();
    expect(host.streams).toEqual([]);

    conversation.setVisible(true);
    expect(host.stream.url).toBe(`${BASE}/conversations/c1/events?after=3`);

    conversation.setVisible(false);
    expect(host.streams[0].closed).toBe(true);
  });

  it('keeps the stream while a turn runs, though nothing shows it', async () => {
    const { host, conversation } = setup();
    conversation.setVisible(true);
    await conversation.send('cart?', null, 'en-US');

    conversation.setVisible(false);

    expect(host.stream.closed).toBe(false);
  });

  it('says a turn is running when the host refuses another, and drops the message', async () => {
    const { host, conversation } = setup();
    host.on('POST', /\/turns$/, () => json({ title: 'A turn is running' }, 409));

    await conversation.send('again', null, 'en-US');

    expect(conversation.current.problem).toEqual({ code: 'turn-running', detail: null });
    expect(conversation.current.items).toEqual([]);
  });

  it('sends the same words to a new conversation when the host forgot the old', async () => {
    const ids = memoryIds();
    const { host, conversation } = setup(ids);
    await conversation.send('one', null, 'en-US');
    host.stream.emit('turn_ended', ENDED, 1);
    await settle();

    let turns = 0;
    host.on('POST', /\/conversations\/c1\/turns$/, () => new Response(null, { status: 404 }));
    host.on('POST', /\/conversations$/, () => json({ id: 'c2' }));
    host.on('POST', /\/conversations\/c2\/turns$/, () => {
      turns++;
      return new Response(null, { status: 202 });
    });

    await conversation.send('two', null, 'en-US');

    expect(ids.id).toBe('c2');
    expect(turns).toBe(1);
    expect(host.stream.url).toBe(`${BASE}/conversations/c2/events?after=0`);
  });

  it('says a send failed, with the host detail, and is not left running', async () => {
    const { host, conversation } = setup();
    host.on('POST', /\/conversations$/, () =>
      json({ title: 'Too many conversations', detail: 'try again later' }, 429),
    );

    await conversation.send('one', null, 'en-US');

    expect(conversation.current.running).toBe(false);
    expect(conversation.current.problem).toEqual({ code: 'failed', detail: 'try again later' });
  });

  it('shows a refusal as its own end, not an empty reply', async () => {
    const { host, conversation } = setup();
    await conversation.send('help', null, 'en-US');

    host.stream.emit('turn_ended', { ...ENDED, reason: 'refused', category: 'cyber' }, 1);

    expect(conversation.current.items.at(-1)).toEqual({
      kind: 'end',
      reason: 'refused',
      category: 'cyber',
    });
  });

  it("shows the host's error event as a provider problem", async () => {
    const { host, conversation } = setup();
    await conversation.send('help', null, 'en-US');

    host.stream.emit(
      'error',
      { type: 'provider-error', title: 'failed', status: 502, detail: 'connection reset' },
      1,
    );

    expect(conversation.current.problem).toEqual({ code: 'provider', detail: 'connection reset' });
  });

  it('cancels the running turn on the host', async () => {
    const { host, conversation } = setup();
    await conversation.send('cart?', null, 'en-US');

    await conversation.cancel();

    expect(host.requests.at(-1)).toEqual({
      method: 'POST',
      url: `${BASE}/conversations/c1/cancel`,
      body: undefined,
    });
  });

  it('starting over forgets the conversation on the host and in the tab', async () => {
    const ids = memoryIds();
    const { host, conversation } = setup(ids);
    await conversation.send('cart?', null, 'en-US');

    await conversation.startOver();

    expect(ids.id).toBeNull();
    expect(conversation.current.items).toEqual([]);
    expect(host.requests.at(-1)?.method).toBe('DELETE');
  });

  it('abandoning drops it here, closes the stream and asks the host nothing', async () => {
    const ids = memoryIds();
    const { host, conversation, opened } = setup(ids);
    await conversation.send('cart?', null, 'en-US');
    const stream = host.stream;
    const asked = host.requests.length;

    conversation.abandon();
    stream.emit(
      'client_tool_call',
      { callId: 'k1', name: 'open_page', input: { page: 'cart' } },
      1,
    );
    await settle();

    expect(ids.id).toBeNull();
    expect(stream.closed).toBe(true);
    expect(conversation.current.items).toEqual([]);
    expect(opened).toEqual([]);
    expect(host.requests.length).toBe(asked);
  });

  it('abandoning hides the conversation, so the next one holds no stream once idle', async () => {
    const { host, conversation } = setup();
    conversation.setVisible(true);

    // The sheet goes with the sign-out and says nothing; abandon is the last word.
    conversation.abandon();
    await conversation.send('next customer', null, 'en-US');
    host.stream.emit('turn_ended', ENDED, 1);
    await settle();

    expect(host.streams.every((s) => s.closed)).toBe(true);
  });

  it('a send whose open lands after an abandon writes nothing back and sends no turn', async () => {
    const host = new FakeHost()
      .on('POST', /\/conversations$/, () => json({ id: 'c1' }))
      .on('POST', /\/turns$/, () => new Response(null, { status: 202 }));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowOpen = async (input: string, init?: RequestInit) => {
      if (input.endsWith('/conversations')) await gate;
      return host.fetch(input, init);
    };
    const ids = memoryIds();
    const conversation = new AssistantConversation(
      new AssistantClient(BASE, slowOpen, host.openStream),
      new ClientToolRegistry(),
      () => OPENING,
      ids,
      () => undefined,
    );

    const sending = conversation.send('one', null, 'en-US');
    conversation.abandon();
    release();
    await sending;
    await settle();

    expect(ids.id).toBeNull();
    expect(conversation.current).toEqual(EMPTY_CONVERSATION);
    expect(host.requests.some((r) => r.url.endsWith('/turns'))).toBe(false);
    expect(host.streams).toEqual([]);
  });
});

describe('AssistantClient', () => {
  it('reads the status, and null when the host cannot say', async () => {
    const host = new FakeHost().on('GET', /\/assistant$/, () =>
      json({ enabled: false, provider: null, model: null, reason: 'off' }),
    );
    expect(await new AssistantClient(BASE, host.fetch).status()).toEqual({
      enabled: false,
      provider: null,
      model: null,
      reason: 'off',
    });

    const failing = new AssistantClient(BASE, () => Promise.reject(new Error('offline')));
    expect(await failing.status()).toBeNull();

    const refused = new AssistantClient(BASE, () => Promise.resolve(json({}, 401)));
    expect(await refused.status()).toBeNull();
  });
});
