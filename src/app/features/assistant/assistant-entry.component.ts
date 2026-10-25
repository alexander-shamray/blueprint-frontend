import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IonButton, IonIcon, IonModal } from '@ionic/angular';
import { AssistantStore } from './assistant.store';
import { AssistantPanelComponent } from './assistant-panel.component';

/**
 * The sheet's stops: closed, half (the page shows above it), and whole. The
 * page behind stays usable at half, which is where the sheet steps to after a
 * UI tool changed it, so the customer sees what the assistant opened.
 */
export const SHEET = { breakpoints: [0, 0.5, 1], whole: 1, half: 0.5 } as const;

/**
 * The assistant's entry point and its sheet (issue #326), placed by the shell.
 * Nothing renders while the store says the assistant is unavailable — off on
 * the BFF, or no customer signed in (AI assistant design §9.1).
 *
 * The sheet open is the conversation visible; closed, the conversation keeps
 * its event stream only while a turn runs, so a hidden, idle assistant holds
 * nothing open (§5.1).
 */
@Component({
  selector: 'app-assistant-entry',
  standalone: true,
  imports: [IonButton, IonIcon, IonModal, AssistantPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // A round ion-button and not ion-fab: every Ionic component this client
  // uses lands in the initial bundle, and ion-fab was new to it (§19).
  styles: `
    .open {
      position: fixed;
      right: 1rem;
      bottom: calc(4.5rem + var(--ion-safe-area-bottom, 0px));
      z-index: 10;
      --border-radius: 50%;
      --padding-start: 0.875rem;
      --padding-end: 0.875rem;
      width: 3.25rem;
      height: 3.25rem;
      margin: 0;
    }
  `,
  template: `
    @if (available()) {
      <ion-button
        class="open"
        (click)="open.set(true)"
        data-testid="assistant-open"
        aria-label="Ask the assistant"
        i18n-aria-label="@@assistant.open"
      >
        <ion-icon slot="icon-only" name="chatbubbles-outline" aria-hidden="true"></ion-icon>
      </ion-button>

      <ion-modal
        [isOpen]="open()"
        [breakpoints]="sheet.breakpoints"
        [initialBreakpoint]="sheet.whole"
        [backdropBreakpoint]="sheet.half"
        (didPresent)="visible(true)"
        (didDismiss)="dismissed()"
      >
        <ng-template>
          <app-assistant-panel (closed)="open.set(false)" />
        </ng-template>
      </ion-modal>
    }
  `,
})
export class AssistantEntryComponent {
  private readonly store = inject(AssistantStore);
  private readonly modal = viewChild(IonModal);

  protected readonly sheet = SHEET;
  protected readonly available = this.store.available;
  protected readonly open = signal(false);

  constructor() {
    effect(() => {
      if (this.store.navigated() === 0) return;
      untracked(() => this.stepAside());
    });
    // An assistant turned unavailable — a sign-out — takes its sheet with it.
    effect(() => {
      if (!this.available()) untracked(() => this.open.set(false));
    });
  }

  protected visible(visible: boolean): void {
    this.store.setVisible(visible);
  }

  protected dismissed(): void {
    this.open.set(false);
    this.store.setVisible(false);
  }

  private stepAside(): void {
    if (!this.open()) return;
    void this.modal()
      ?.setCurrentBreakpoint(SHEET.half)
      .catch(() => undefined);
  }
}
