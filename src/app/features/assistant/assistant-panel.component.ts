import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonNote,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { ConversationItem } from '@core/assistant/protocol';
import { AssistantStore } from './assistant.store';
import { endLabel, problemLabel, toolLabel } from './assistant-words';

/**
 * The longest message the BFF takes, in characters
 * (`Web.Bff/Assistant/AssistantEndpoints.cs` — `MaxTextLength`): the box stops
 * there rather than sending one the BFF refuses.
 */
export const MAX_MESSAGE_LENGTH = 4_000;

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

/**
 * The assistant's chat (issue #326): the conversation, the box to write in,
 * and the one control a running turn needs, Stop. A refusal and every other
 * unusual end are said in words (AI assistant design §5.3), and the provider
 * the questions go to is named before the first one is sent (§10).
 */
@Component({
  selector: 'app-assistant-panel',
  standalone: true,
  imports: [
    IonButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonNote,
    IonSpinner,
    IonTextarea,
    IonTitle,
    IonToolbar,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .log {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .bubble {
      max-width: 85%;
      padding: 0.5rem 0.75rem;
      border-radius: 1rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .mine {
      align-self: flex-end;
      background: var(--ion-color-primary);
      color: var(--ion-color-primary-contrast);
    }
    .theirs {
      align-self: flex-start;
      background: var(--ion-color-light);
      color: var(--ion-color-light-contrast);
    }
    .tool {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.875rem;
      color: var(--ion-color-medium);
    }
    .tool ion-spinner {
      width: 1rem;
      height: 1rem;
    }
    .end {
      margin: 0;
      font-size: 0.875rem;
      color: var(--ion-color-medium);
    }
    .end.refused {
      color: var(--ion-color-warning-shade);
    }
    .notice {
      padding: 0.75rem;
      border-radius: 0.5rem;
      background: var(--ion-color-light);
    }
    .composer {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      padding: 0 0.5rem;
    }
    .composer ion-textarea {
      flex: 1;
    }
  `,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title i18n="@@assistant.title">Assistant</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="startOver()" [disabled]="empty()" i18n="@@assistant.startOver"
            >Start over</ion-button
          >
          <ion-button
            (click)="closed.emit()"
            aria-label="Close the assistant"
            i18n-aria-label="@@assistant.close"
          >
            <ion-icon slot="icon-only" name="close-outline" aria-hidden="true"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      @if (noticePending()) {
        <div class="notice" data-testid="assistant-notice">
          <p i18n="@@assistant.notice">
            Your questions, and the orders and products the assistant reads to answer them, are sent
            to {{ provider() }}.
          </p>
          <ion-button
            (click)="acknowledge()"
            data-testid="assistant-notice-ok"
            i18n="@@assistant.noticeOk"
            >I understand</ion-button
          >
        </div>
      } @else if (empty()) {
        <ion-note i18n="@@assistant.empty"
          >Ask about your orders, a product or how the shop works.</ion-note
        >
      }

      <div
        class="log"
        role="log"
        aria-live="polite"
        i18n-aria-label="@@assistant.log"
        aria-label="Conversation"
      >
        @for (item of items(); track $index) {
          @if (item.kind === 'operator') {
            <div class="bubble mine" data-testid="assistant-mine">{{ item.text }}</div>
          } @else if (item.kind === 'reply') {
            <div class="bubble theirs" data-testid="assistant-reply">{{ item.text }}</div>
          } @else if (item.kind === 'tool') {
            <div class="tool" data-testid="assistant-tool">
              @if (item.ok === null) {
                <ion-spinner name="crescent" aria-hidden="true"></ion-spinner>
              } @else if (item.ok) {
                <ion-icon name="checkmark-outline" aria-hidden="true"></ion-icon>
              } @else {
                <ion-icon name="alert-circle-outline" aria-hidden="true"></ion-icon>
              }
              <span>{{ label(item) }}</span>
            </div>
          } @else {
            @if (ended(item); as words) {
              <p class="end" [class.refused]="refused(item)" data-testid="assistant-end">
                {{ words }}
              </p>
            }
          }
        }
      </div>

      @if (problem(); as problem) {
        <p role="alert" data-testid="assistant-problem">
          <ion-note color="danger">{{ problemWords(problem) }}</ion-note>
          @if (problem.detail) {
            <ion-note> {{ problem.detail }}</ion-note>
          }
        </p>
      }
    </ion-content>

    <ion-footer>
      <ion-toolbar>
        <div class="composer">
          <ion-textarea
            [value]="draft()"
            (ionInput)="draft.set($event.detail.value ?? '')"
            (keydown.enter)="onEnter($event)"
            [autoGrow]="true"
            [rows]="1"
            [maxlength]="maxLength"
            [disabled]="noticePending()"
            aria-label="Message"
            i18n-aria-label="@@assistant.message"
            placeholder="Ask the assistant"
            i18n-placeholder="@@assistant.placeholder"
          ></ion-textarea>
          @if (running()) {
            <ion-button
              (click)="cancel()"
              color="medium"
              data-testid="assistant-stop"
              i18n="@@assistant.stop"
              >Stop</ion-button
            >
          } @else {
            <ion-button
              (click)="send()"
              [disabled]="!canSend()"
              data-testid="assistant-send"
              i18n="@@assistant.send"
              >Send</ion-button
            >
          }
        </div>
      </ion-toolbar>
    </ion-footer>
  `,
})
export class AssistantPanelComponent {
  private readonly store = inject(AssistantStore);
  private readonly content = viewChild(IonContent);

  readonly closed = output<void>();

  protected readonly maxLength = MAX_MESSAGE_LENGTH;
  protected readonly draft = signal('');
  protected readonly provider = this.store.provider;
  protected readonly noticePending = this.store.noticePending;
  protected readonly items = computed(() => this.store.state().items);
  protected readonly running = computed(() => this.store.state().running);
  protected readonly problem = computed(() => this.store.state().problem);
  protected readonly empty = computed(() => this.items().length === 0);
  protected readonly canSend = computed(
    () => !this.noticePending() && !this.running() && this.draft().trim() !== '',
  );

  constructor() {
    // The newest line in view as it arrives, as a chat reads.
    effect(() => {
      this.items();
      queueMicrotask(() => this.scrollToEnd());
    });
  }

  protected label(item: ToolItem): string {
    return toolLabel(item.name, item.args);
  }

  protected ended(item: ConversationItem): string | null {
    return item.kind === 'end' ? endLabel(item.reason) : null;
  }

  protected refused(item: ConversationItem): boolean {
    return item.kind === 'end' && item.reason === 'refused';
  }

  protected problemWords = problemLabel;

  protected acknowledge(): void {
    void this.store.acknowledgeNotice();
  }

  protected onEnter(event: Event): void {
    // Enter sends and Shift+Enter breaks the line, as a chat box does.
    if ((event as KeyboardEvent).shiftKey) return;
    event.preventDefault();
    this.send();
  }

  protected send(): void {
    if (!this.canSend()) return;
    const text = this.draft();
    this.draft.set('');
    void this.store.send(text);
  }

  protected cancel(): void {
    void this.store.cancel();
  }

  protected startOver(): void {
    void this.store.startOver();
  }

  private scrollToEnd(): void {
    try {
      void this.content()?.scrollToBottom(150);
    } catch {
      // Not yet upgraded, as under a test: there is nothing to scroll.
    }
  }
}
