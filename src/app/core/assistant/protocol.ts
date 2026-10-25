/**
 * The assistant's protocol (AI assistant design §5, `blueprint-admin`'s
 * `docs/superpowers/specs/2026-10-22-ai-assistant-design.md`), mirrored from
 * its owner: `blueprint-backend`'s
 * `src/BuildingBlocks/Common.Assistant/Protocol/Resources.cs` and `Events.cs`,
 * and `Common.Assistant/Tools/ToolDescriptor.cs`. The golden files beside them
 * pin the JSON; `golden/` here is a copy of them, `protocol.spec.ts` holds
 * these types to the copy, and `e2e/assistant-drift.spec.ts` holds the copy to
 * the backend's files, so the mirror cannot drift from its owner unnoticed.
 *
 * Copied from `blueprint-admin`'s `src/Admin.Web/src/app/assistant/protocol.ts`
 * (design §13), with `readonly` on every field, as this client's wire types
 * carry it. Framework-free: nothing here imports Angular. Every code below is a
 * code, never a sentence; the client words it in its own language (§5.4).
 */

/** Why the assistant is not enabled. */
export type StatusReason = 'off' | 'no-credential' | 'unreachable';

/** `Resources.cs` — `AssistantStatus`. */
export interface AssistantStatus {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reason: StatusReason | null;
}

export type ToolSide = 'server' | 'client';

/** `ToolDescriptor.cs` — a tool in the Model Context Protocol's shape, plus its side (§6). */
export interface ToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly side: ToolSide;
}

/** `Resources.cs` — `CatalogueEntry`: one thing the client can explain (§6.1). */
export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  readonly where: string;
  readonly help: string;
}

/** `Resources.cs` — `OpenConversation`. */
export interface OpenConversation {
  readonly client: { readonly name: string; readonly version: string };
  readonly locale: string;
  readonly catalogue: readonly CatalogueEntry[];
  readonly clientTools: readonly ToolDescriptor[];
  readonly hostOptions: Readonly<Record<string, unknown>> | null;
}

/** `Resources.cs` — `ConversationOpened`. */
export interface ConversationOpened {
  readonly id: string;
}

/** `Resources.cs` — `StartTurn`. */
export interface StartTurn {
  readonly text: string;
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly locale: string | null;
  readonly hostOptions: Readonly<Record<string, unknown>> | null;
}

/** `Resources.cs` — `ClientToolResult`. */
export interface ClientToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly content: string;
}

export type TurnEndReason = 'done' | 'max_steps' | 'budget' | 'cancelled' | 'refused' | 'error';

/** Every end reason, so a spec can walk them and hold each to a worded message. */
export const TURN_END_REASONS: readonly TurnEndReason[] = [
  'done',
  'max_steps',
  'budget',
  'cancelled',
  'refused',
  'error',
];

/** Every status reason, for the same walk. */
export const STATUS_REASONS: readonly StatusReason[] = ['off', 'no-credential', 'unreachable'];

/** `Resources.cs` — `ConversationItem` and its four kinds. */
export type ConversationItem =
  | { readonly kind: 'operator'; readonly text: string }
  | { readonly kind: 'reply'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly callId: string;
      readonly name: string;
      readonly side: ToolSide;
      readonly args: Readonly<Record<string, unknown>>;
      readonly ok: boolean | null;
    }
  | { readonly kind: 'end'; readonly reason: TurnEndReason; readonly category: string | null };

/** `Resources.cs` — `ConversationView`. */
export interface ConversationView {
  readonly id: string;
  readonly items: readonly ConversationItem[];
  readonly running: boolean;
  readonly lastEventId: number;
  /** Client calls still waiting for a result, as `client_tool_call` carries them. */
  readonly pendingCalls: readonly AssistantEvents['client_tool_call'][];
}

/** `Events.cs` — `Usage`. */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
}

/** `Events.cs` — each Server-Sent Event's data, by its `EventName` (§5.3). */
export interface AssistantEvents {
  readonly text: { readonly delta: string };
  readonly tool_started: {
    readonly callId: string;
    readonly name: string;
    readonly side: ToolSide;
    readonly args: Readonly<Record<string, unknown>>;
  };
  readonly tool_finished: { readonly callId: string; readonly ok: boolean };
  readonly client_tool_call: {
    readonly callId: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  };
  readonly turn_ended: {
    readonly reason: TurnEndReason;
    readonly category: string | null;
    readonly usage: Usage;
    readonly total: Usage;
  };
  readonly error: {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string | null;
  };
  /** Reserved (§6.3): never emitted until actions are allowed, and ignored until then. */
  readonly confirmation_required: {
    readonly callId: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly confirmation: string | null;
  };
}

export type AssistantEventName = keyof AssistantEvents;

/** The event names a client listens for; the reserved `confirmation_required` is left out. */
export const EVENT_NAMES: readonly AssistantEventName[] = [
  'text',
  'tool_started',
  'tool_finished',
  'client_tool_call',
  'turn_ended',
  'error',
];

export type AssistantEvent = {
  [K in AssistantEventName]: {
    readonly name: K;
    readonly data: AssistantEvents[K];
    readonly id: number;
  };
}[AssistantEventName];
