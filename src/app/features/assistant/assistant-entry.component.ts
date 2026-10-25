import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IonFab, IonFabButton, IonIcon, IonModal } from '@ionic/angular';
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
  imports: [IonFab, IonFabButton, IonIcon, IonModal, AssistantPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    ion-fab {
      position: fixed;
      right: 1rem;
      bottom: calc(4.5rem + var(--ion-safe-area-bottom, 0px));
    }
  `,
  template: `
    @if (available()) {
      <ion-fab>
        <ion-fab-button
          (click)="open.set(true)"
          data-testid="assistant-open"
          aria-label="Ask the assistant"
          i18n-aria-label="@@assistant.open"
        >
          <ion-icon name="chatbubbles-outline" aria-hidden="true"></ion-icon>
        </ion-fab-button>
      </ion-fab>

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
