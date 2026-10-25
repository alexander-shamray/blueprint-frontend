import { Injectable, LOCALE_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { PERMISSIONS } from '@core/api/types';
import {
  AssistantConversation,
  ConversationState,
  EMPTY_CONVERSATION,
  IdStore,
} from '@core/assistant/assistant-client';
import { AssistantTransport } from '@core/assistant/assistant-transport';
import { ClientToolRegistry } from '@core/assistant/client-tools';
import { AssistantStatus, OpenConversation } from '@core/assistant/protocol';
import { AuthService } from '@core/auth/auth.service';
import { shopCatalogue } from './shop-catalogue';
import { shopTools } from './shop-tools';

/**
 * Where the tab keeps its conversation's id (AI assistant design §5.5): for
 * the tab, so a reload redraws the conversation and a new tab starts its own.
 */
export const CONVERSATION_KEY = 'blueprint.assistant.conversation';

/**
 * The Preferences key holding the provider the customer was told about
 * (design §10, "Notice"): the first message waits on that acknowledgement, and
 * a different provider asks again.
 */
export const NOTICE_KEY = 'assistant-notice';

/** What the shop says it is when it opens a conversation. */
export const CLIENT = { name: 'blueprint-frontend', version: '1' } as const;

/** A storage that refuses (a private window, blocked site data) keeps no id; nothing fails. */
const TAB_IDS: IdStore = {
  get: () => {
    try {
      return sessionStorage.getItem(CONVERSATION_KEY);
    } catch {
      return null;
    }
  },
  set: (id) => {
    try {
      if (id === null) sessionStorage.removeItem(CONVERSATION_KEY);
      else sessionStorage.setItem(CONVERSATION_KEY, id);
    } catch {
      // Without storage a reload starts a new conversation, which is all it costs.
    }
  },
};

/**
 * The customer's assistant (issue #326, `docs/client-architecture.md` §19):
 * whether it is on, its one conversation, and what the panel does to it.
 *
 * **Off is the BFF's to say.** The status is read when a customer signs in,
 * because the BFF's whole `/v1/assistant` group requires a principal; until a
 * read says `enabled`, `available` is false and nothing of the assistant
 * renders (design §9.1). Signing out drops the conversation here without
 * asking the host, which no longer admits the caller it belonged to.
 */
@Injectable({ providedIn: 'root' })
export class AssistantStore {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  private readonly client = inject(AssistantTransport).client();
  private readonly tools = new ClientToolRegistry();

  private readonly status = signal<AssistantStatus | null>(null);
  private readonly conversationState = signal<ConversationState>(EMPTY_CONVERSATION);
  private readonly acknowledged = signal<string | null>(null);
  private readonly navigations = signal(0);
  /** The subject last seen; `undefined` until the first read. */
  private lastSubject: string | null | undefined = undefined;

  private readonly subject = computed(() => this.auth.user()()?.subject ?? null);
  private readonly conversation = new AssistantConversation(
    this.client,
    this.tools,
    () => this.opening(),
    TAB_IDS,
    (state) => this.conversationState.set(state),
  );

  /** Whether the assistant's entry point and panel render at all. */
  readonly available = computed(() => this.status()?.enabled === true);
  /** The provider the conversation goes to, named in the panel (design §10). */
  readonly provider = computed(() => this.status()?.provider ?? null);
  /** Whether the first message still waits on the data notice being acknowledged. */
  readonly noticePending = computed(() => this.acknowledged() !== this.provider());
  readonly state = this.conversationState.asReadonly();
  /** Bumped each time a UI tool changed the page, so the panel can step aside to show it. */
  readonly navigated = this.navigations.asReadonly();

  constructor() {
    for (const tool of shopTools({
      navigate: (commands) => this.navigate(commands),
      canPublish: () => this.canPublish(),
    })) {
      this.tools.register(tool);
    }

    void this.readNotice();

    effect(() => {
      const subject = this.subject();
      untracked(() => this.signedIn(subject));
    });
  }

  setVisible(visible: boolean): void {
    this.conversation.setVisible(visible);
  }

  async acknowledgeNotice(): Promise<void> {
    const provider = this.provider();
    if (provider === null) return;
    this.acknowledged.set(provider);
    try {
      await Preferences.set({ key: NOTICE_KEY, value: provider });
    } catch {
      // Unrecorded, the notice is shown again next time, which is the safe side.
    }
  }

  /** Sends the customer's message, with the route they are on as its context (design §5.1). */
  async send(text: string): Promise<void> {
    if (!this.available() || this.noticePending()) return;
    await this.conversation.send(text, { route: this.router.url }, this.locale);
  }

  cancel(): Promise<void> {
    return this.conversation.cancel();
  }

  startOver(): Promise<void> {
    return this.conversation.startOver();
  }

  /**
   * The first read is the session the app started with, so it drops nothing:
   * the tab's conversation is still the one a reload should redraw. Only a
   * change away from a customer abandons theirs.
   */
  private signedIn(subject: string | null): void {
    if (subject === this.lastSubject) return;
    const previous = this.lastSubject;
    this.lastSubject = subject;
    this.status.set(null);
    if (previous !== undefined && previous !== null) this.conversation.abandon();
    if (subject !== null) void this.load(subject);
  }

  private async load(subject: string): Promise<void> {
    const status = await this.client.status();
    // A sign-out, or another customer, since the read began makes it stale.
    if (this.subject() !== subject) return;
    this.status.set(status);
    if (status?.enabled) await this.conversation.resume();
  }

  private async readNotice(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: NOTICE_KEY });
      if (value !== null && this.acknowledged() === null) this.acknowledged.set(value);
    } catch {
      // Unread, the notice is shown, which is the safe side.
    }
  }

  private opening(): OpenConversation {
    return {
      client: CLIENT,
      locale: this.locale,
      catalogue: shopCatalogue(this.canPublish()),
      clientTools: this.tools.descriptors(),
      hostOptions: null,
    };
  }

  private canPublish(): boolean {
    return this.auth.hasPermission(PERMISSIONS.catalogWrite);
  }

  private async navigate(commands: readonly string[]): Promise<boolean> {
    const done = await this.router.navigate([...commands]);
    if (done) this.navigations.update((n) => n + 1);
    return done;
  }
}
