import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AssistantEvents,
  AssistantStatus,
  ClientToolResult,
  ConversationOpened,
  ConversationView,
  OpenConversation,
  StartTurn,
} from './protocol';

/**
 * The TypeScript mirror held to its owner (AI assistant design §14,
 * "Protocol"): each golden file the backend's C# records are tested against
 * equals a value typed here, so a field renamed, added or retyped on either
 * side fails one of the two. `golden/` is a copy; `e2e/assistant-drift.spec.ts`
 * holds the copy to the backend's own files, in the one CI job that checks the
 * backend out.
 */
const GOLDEN = join(process.cwd(), 'src', 'app', 'core', 'assistant', 'golden');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), 'utf8'));
}

/** Every file this spec reads, so a golden file added to the copy cannot go unread. */
const READ = [
  'client-tool-result',
  'conversation-opened',
  'conversation-view',
  'event-client-tool-call',
  'event-confirmation-required',
  'event-error',
  'event-text',
  'event-tool-finished',
  'event-tool-started',
  'event-turn-ended',
  'open-conversation',
  'start-turn',
  'status-enabled',
  'status-off',
];

describe('the assistant protocol mirror', () => {
  const tool = {
    name: 'open_screen',
    title: 'Open a screen',
    description: 'Routes the console to a screen by its id.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    side: 'client',
  } as const;

  it('reads every golden file in the copy', () => {
    const files = readdirSync(GOLDEN)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();

    expect(files).toEqual([...READ].sort());
  });

  it('reads every body the host writes', () => {
    expect(golden('status-enabled')).toEqual({
      enabled: true,
      provider: 'fake',
      model: 'scripted',
      reason: null,
    } satisfies AssistantStatus);
    expect(golden('status-off')).toEqual({
      enabled: false,
      provider: null,
      model: null,
      reason: 'off',
    } satisfies AssistantStatus);
    expect(golden('conversation-opened')).toEqual({
      id: '0123456789abcdef0123456789abcdef',
    } satisfies ConversationOpened);
    expect(golden('conversation-view')).toEqual({
      id: '0123456789abcdef0123456789abcdef',
      items: [
        { kind: 'operator', text: 'где логи?' },
        { kind: 'reply', text: 'Открываю «Logs». ' },
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'open_screen',
          side: 'client',
          args: { path: 'logs' },
          ok: true,
        },
        { kind: 'reply', text: 'Экран «Logs» открыт.' },
        { kind: 'end', reason: 'done', category: null },
      ],
      running: false,
      lastEventId: 7,
      pendingCalls: [],
    } satisfies ConversationView);
  });

  it('writes every body the host reads', () => {
    expect(golden('open-conversation')).toEqual({
      client: { name: 'blueprint-admin', version: '1' },
      locale: 'ru-RU',
      catalogue: [
        { id: 'logs', label: 'Logs', where: '/logs', help: "Follows the platform's log lines." },
      ],
      clientTools: [tool],
      hostOptions: { identity: 'demo' },
    } satisfies OpenConversation);
    expect(golden('start-turn')).toEqual({
      text: 'где логи?',
      context: { page: 'stack' },
      locale: 'ru-RU',
      hostOptions: null,
    } satisfies StartTurn);
    expect(golden('client-tool-result')).toEqual({
      callId: 'call-1',
      ok: true,
      content: 'Opened /logs.',
    } satisfies ClientToolResult);
  });

  it('reads every event', () => {
    const events: { [K in keyof AssistantEvents]: [unknown, AssistantEvents[K]] } = {
      text: [golden('event-text'), { delta: 'Открываю «Logs». ' }],
      tool_started: [
        golden('event-tool-started'),
        { callId: 'call-1', name: 'open_screen', side: 'client', args: { path: 'logs' } },
      ],
      tool_finished: [golden('event-tool-finished'), { callId: 'call-1', ok: true }],
      client_tool_call: [
        golden('event-client-tool-call'),
        { callId: 'call-1', name: 'open_screen', input: { path: 'logs' } },
      ],
      turn_ended: [
        golden('event-turn-ended'),
        {
          reason: 'refused',
          category: 'cyber',
          usage: { input: 120, output: 8, cached: 100 },
          total: { input: 240, output: 30, cached: 100 },
        },
      ],
      error: [
        golden('event-error'),
        {
          type: 'provider-error',
          title: "The assistant's provider failed",
          status: 502,
          detail: 'connection reset',
        },
      ],
      confirmation_required: [
        golden('event-confirmation-required'),
        { callId: 'call-2', name: 'stack_down', args: { wipe: true }, confirmation: 'down -v' },
      ],
    };
    for (const [file, typed] of Object.values(events)) expect(file).toEqual(typed);
  });
});
