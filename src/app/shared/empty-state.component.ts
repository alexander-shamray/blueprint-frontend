import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IonIcon, IonText } from '@ionic/angular';

/**
 * What a list says when it has nothing in it, as opposed to when it has not
 * loaded yet — those are different facts, and a blank screen states neither.
 * The way out, when there is one, is projected: the cart links to Products,
 * the listing has nothing to link to, and the component does not guess.
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [IonIcon, IonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" data-testid="empty-state">
      <ion-icon [name]="icon()" aria-hidden="true"></ion-icon>
      <ion-text><h2>{{ heading() }}</h2></ion-text>
      @if (message()) {
        <p>{{ message() }}</p>
      }
      <ng-content />
    </div>
  `,
  styles: `
    .empty { display: flex; flex-direction: column; align-items: center; text-align: center;
             gap: .5rem; padding: 3rem 1.5rem; color: var(--ion-color-medium); }
    ion-icon { font-size: 3rem; }
    h2 { margin: 0; }
    p { margin: 0; }
  `,
})
export class EmptyStateComponent {
  readonly heading = input.required<string>();
  readonly message = input<string | null>(null);
  readonly icon = input('file-tray-outline');
}
